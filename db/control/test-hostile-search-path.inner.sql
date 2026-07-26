-- Companion to test-hostile-search-path.sh. Runs in the same connection as
-- the real upgrade so the hostile shadows below are visible to it. Not
-- meant to be run standalone.
--
-- The realistic attack shape (CVE-2018-1058-style): an ambient search_path
-- — set by role default, prior session state, or a misconfigured caller —
-- lists an attacker-writable schema before pg_catalog. Unqualified calls to
-- to_regnamespace/to_regclass/pg_get_constraintdef would then resolve to
-- the attacker's functions instead of the real catalog ones.
--
-- (pg_temp is deliberately not used for the shadow here: PostgreSQL only
-- gives the temporary-object schema implicit search priority for
-- relations, not for functions, so a pg_temp function shadow would not
-- actually be exploitable and would make this a vacuous test.)
create schema hostile_search_path_probe;

-- Every shadow lies in the direction that would break the real upgrade if
-- the production script ever resolved these names unqualified: "the schema
-- doesn't exist", and "the constraint is CHECK(true)" (which matches
-- neither pinned fixture, so an unqualified script would wrongly fail
-- closed even on a legitimate previous-schema installation).
create function hostile_search_path_probe.to_regnamespace(text)
returns regnamespace language sql as $$ select null::regnamespace $$;

create function hostile_search_path_probe.to_regclass(text)
returns regclass language sql as $$ select null::regclass $$;

create function hostile_search_path_probe.pg_get_constraintdef(oid, boolean)
returns text language sql as $$ select 'CHECK (true)'::text $$;

set search_path = hostile_search_path_probe, public, pg_catalog;

\i :script_dir/control-schema-upgrade.sql

drop schema hostile_search_path_probe cascade;
