import fs from 'node:fs/promises';
import { PGlite} from '@electric-sql/pglite';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';
import { pg_stat_statements } from '@electric-sql/pglite/contrib/pg_stat_statements';

async function main() {
  // 1. PGlite Instanz initialisieren
  const pg = new PGlite({
    extensions: { pg_stat_statements, auto_explain }
  });

  // 2. Extensions aktivieren
  const res1 = await pg.exec('CREATE EXTENSION IF NOT EXISTS auto_explain;');
  console.log('Auto Explain:', res1);
  
  const res2 = await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
  console.log('Stat Statements:', res2);

  // 3. Initiale History-Befehle ausführen
  await pg.exec("CREATE TABLE test (id serial primary key, name text);");
  await pg.exec("INSERT INTO test (name) VALUES ('Alice');");
  console.log("Ready! Initiale Tabellen erstellt.");

  // 4. Lokale SQL-Datei laden und ausführen
  const localFilePath = './user.sql';
  console.log("Loading SQL from:", localFilePath);

  try {
    // Liest die lokale Datei als Text (UTF-8) ein
    const data = await fs.readFile(localFilePath, 'utf-8');
    
    // SQL-Inhalt in der Datenbank ausführen
    const res = await pg.exec(data);
    console.log('SQL Ausführung erfolgreich:', res);
    
  } catch (error) {
    console.error('Error reading or executing local SQL file:', error);
  }
}

main();
