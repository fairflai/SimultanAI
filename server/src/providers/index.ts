import type { Provider } from './provider.ts';
import { OpenAIProvider } from './impl/openai.ts';
import { GoogleProvider } from './impl/google.ts';

const PROVIDERS: Record<string, new () => Provider> = { openai: OpenAIProvider, google: GoogleProvider };

// PROVIDER env selects the vendor; a new vendor is one file in impl/ plus one entry here.
export function createProvider(name = process.env.PROVIDER || 'openai'): Provider {
  const Impl = PROVIDERS[name];
  if (!Impl) throw new Error(`unknown PROVIDER "${name}", valid values: ${Object.keys(PROVIDERS).join(', ')}`);
  return new Impl();
}
