-- The Supabase image creates these service roles during cluster initialization.
\getenv db_password POSTGRES_PASSWORD
ALTER USER authenticator WITH PASSWORD :'db_password';
ALTER USER supabase_auth_admin WITH PASSWORD :'db_password';
ALTER USER supabase_storage_admin WITH PASSWORD :'db_password';

\getenv workflow_password WORKFLOW_PASSWORD
CREATE ROLE workflow LOGIN PASSWORD :'workflow_password';
CREATE DATABASE workflow OWNER workflow;
