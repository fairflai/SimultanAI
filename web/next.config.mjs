import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Single .env at the repo root, shared with the server. Missing on hosts that inject
// NEXT_PUBLIC_SERVER_URL themselves (Vercel); values already in the environment win
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

export default {};
