create table auth_state (
  id              integer primary key check (id = 1),
  session_version integer not null default 1
);
insert into auth_state (id) values (1);
