import { migration_0001_init } from './0001_init.js';
import { migration_0002_api_key_metadata } from './0002_api_key_metadata.js';

export const migrations = [migration_0001_init, migration_0002_api_key_metadata] as const;
