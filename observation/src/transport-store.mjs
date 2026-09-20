import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function openTransportStore(file, legacyRoot) {
  if (!file || !legacyRoot) throw Error('state file and legacy exclusion root are required');
  const destination=path.resolve(file), legacy=path.resolve(legacyRoot);
  const canonical=v=>process.platform==='win32'?v.toLowerCase():v;
  if(canonical(destination)===canonical(legacy)||canonical(destination).startsWith(canonical(legacy)+path.sep))throw Error('state cannot be inside V1');
  for(let at=destination;;at=path.dirname(at)){
    if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())throw Error('state cannot traverse symlinks');
    if(at===path.dirname(at))break;
  }
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const db=new DatabaseSync(destination);
  if(process.platform!=='win32')fs.chmodSync(destination,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY,worker TEXT NOT NULL,epoch INTEGER NOT NULL,envelope TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT);
    CREATE TABLE IF NOT EXISTS local_jobs(key TEXT PRIMARY KEY,binding TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT);`);
  const version=db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if(version&&version!=='1'){db.close();throw Error('unsupported transport schema version');}
  db.prepare("INSERT OR IGNORE INTO meta VALUES('schema_version','1')").run();
  return db;
}

export function transaction(db,fn){
  db.exec('BEGIN IMMEDIATE');
  try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}
}
