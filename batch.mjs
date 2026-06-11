import fs from 'node:fs/promises';
import { PGlite} from '@electric-sql/pglite';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';

async function main() {
  // 1. PGlite Instanz initialisieren
  const pg = new PGlite({
    extensions: { auto_explain }
  });

  // 2. auto_explain konfigurieren (kein CREATE EXTENSION – es ist eine preload library)
  await pg.exec("SET auto_explain.log_min_duration = 0;");
  await pg.exec("SET auto_explain.log_analyze = true;");
  console.log('Auto Explain configured.');

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
    console.log('SQL Ausführung erfolgreich:');

    res.forEach((packet, index) => {
      console.log(`--- Paket ${index + 1} (affectedRows: ${packet.affectedRows}) ---`);
  
      if (packet.rows && packet.rows.length > 0) {
        packet.rows.forEach((row, rowIndex) => {
          console.log(`  Zeile ${rowIndex + 1}:`, JSON.stringify(row));
        });
      } else {
        console.log("  Keine Zeilen vorhanden.");
      }
    });
    
  } catch (error) {
    console.error('Error reading or executing local SQL file:', error);
  }
}

main();
