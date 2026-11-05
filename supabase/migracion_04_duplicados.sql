-- =====================================================================
-- COLFOG AGRO APP · Migración 04: control de duplicados
--  1. Trabajos y gastos se pueden ANULAR (no se borran): dejan de contar
--     en el tablero y en la liquidación, y se pueden restaurar.
--  2. Solo el administrador puede anular o restaurar.
--  3. Funciones para avisar, antes de guardar, si ya existe un registro
--     igual (aunque lo haya creado otro usuario).
--  4. Tabla para recordar los grupos que el admin marcó "No son duplicados".
-- Ejecutar completo en Supabase > SQL Editor > New query > Run
-- Se puede correr más de una vez sin problema.
-- =====================================================================

-- 1. Columnas de anulación -------------------------------------------
alter table trabajos add column if not exists anulado        boolean not null default false;
alter table trabajos add column if not exists anulado_motivo text;
alter table trabajos add column if not exists anulado_por    uuid references perfiles(id);
alter table trabajos add column if not exists anulado_at     timestamptz;
alter table trabajos add column if not exists duplicado_de   uuid references trabajos(id);

alter table gastos add column if not exists anulado        boolean not null default false;
alter table gastos add column if not exists anulado_motivo text;
alter table gastos add column if not exists anulado_por    uuid references perfiles(id);
alter table gastos add column if not exists anulado_at     timestamptz;
alter table gastos add column if not exists duplicado_de   uuid references gastos(id);

create index if not exists trabajos_jd_idx on trabajos (jornada_dron_id);
create index if not exists gastos_fecha_idx on gastos (fecha);

-- 2. Solo el admin puede anular / restaurar -----------------------------
--    (desde el SQL Editor, auth.uid() es nulo y se permite)
create or replace function proteger_anulacion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not es_admin() then
    if tg_op = 'INSERT' then
      new.anulado := false; new.anulado_motivo := null; new.anulado_por := null;
      new.anulado_at := null; new.duplicado_de := null;
    elsif (new.anulado, new.anulado_motivo, new.anulado_por, new.anulado_at, new.duplicado_de)
          is distinct from
          (old.anulado, old.anulado_motivo, old.anulado_por, old.anulado_at, old.duplicado_de) then
      raise exception 'Solo el administrador puede anular registros';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trabajos_proteger_anulacion on trabajos;
create trigger trabajos_proteger_anulacion before insert or update on trabajos
  for each row execute function proteger_anulacion();

drop trigger if exists gastos_proteger_anulacion on gastos;
create trigger gastos_proteger_anulacion before insert or update on gastos
  for each row execute function proteger_anulacion();

-- 3. Búsqueda de posibles duplicados (ve todos los usuarios, pero solo
--    devuelve lo mínimo: Ha o valor, quién lo registró y cuándo) ---------
create or replace function buscar_trabajo_duplicado(p_fecha date, p_dron text, p_cliente text, p_finca text)
returns table (id uuid, ha numeric, cliente text, finca text, registrado_por text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.ha, t.cliente, t.finca, p.nombre, t.created_at
  from trabajos t
  join jornada_drones jd on jd.id = t.jornada_dron_id
  join jornadas j on j.id = jd.jornada_id
  left join perfiles p on p.id = t.creado_por
  where auth.uid() is not null
    and not t.anulado
    and j.fecha = p_fecha
    and jd.dron_id = p_dron
    and lower(regexp_replace(trim(t.cliente), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_cliente), '\s+', ' ', 'g'))
    and lower(regexp_replace(trim(coalesce(t.finca, '')), '\s+', ' ', 'g')) = lower(regexp_replace(trim(coalesce(p_finca, '')), '\s+', ' ', 'g'))
  order by t.created_at desc
  limit 5
$$;

create or replace function buscar_gasto_duplicado(p_fecha date, p_dron text, p_categoria text, p_valor numeric)
returns table (id uuid, valor numeric, categoria text, descripcion text, estado text, registrado_por text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g.id, g.valor, g.categoria, g.descripcion, g.estado, p.nombre, g.created_at
  from gastos g
  left join perfiles p on p.id = g.creado_por
  where auth.uid() is not null
    and not g.anulado
    and g.estado <> 'rechazado'
    and g.fecha = p_fecha
    and coalesce(g.dron_id, '') = coalesce(p_dron, '')
    and g.categoria = p_categoria
    and g.valor = p_valor
  order by g.created_at desc
  limit 5
$$;

grant execute on function buscar_trabajo_duplicado(date, text, text, text) to authenticated;
grant execute on function buscar_gasto_duplicado(date, text, text, numeric) to authenticated;

-- 4. Grupos revisados ("No son duplicados") ------------------------------
create table if not exists duplicados_revisados (
  clave         text primary key,            -- ids del grupo, ordenados y separados por coma
  revisado_por  uuid not null default auth.uid() references perfiles(id),
  created_at    timestamptz not null default now()
);

alter table duplicados_revisados enable row level security;

drop policy if exists dup_rev_admin on duplicados_revisados;
create policy dup_rev_admin on duplicados_revisados for all
  using (es_admin()) with check (es_admin());

grant select, insert, update, delete on duplicados_revisados to authenticated;

-- Verificación: debe devolver las 5 columnas nuevas de cada tabla
select table_name, column_name from information_schema.columns
where table_schema = 'public' and table_name in ('trabajos', 'gastos')
  and column_name in ('anulado', 'anulado_motivo', 'anulado_por', 'anulado_at', 'duplicado_de')
order by table_name, column_name;
