import type { Provider } from './provider.ts';
import { DeepLProvider } from './impl/deepl.ts';
import { GoogleProvider } from './impl/google.ts';
import { OpenAIProvider } from './impl/openai.ts';
import { PalabraProvider } from './impl/palabra.ts';

const PROVIDERS: Record<string, new () => Provider> = { deepl: DeepLProvider, google: GoogleProvider, openai: OpenAIProvider, palabra: PalabraProvider };

// PROVIDER env selects the provider; a new provider is one file in impl/ plus one entry here.
export function createProvider(name = process.env.PROVIDER || 'openai'): Provider {
  const Impl = PROVIDERS[name];
  if (!Impl) throw new Error(`unknown PROVIDER "${name}", valid values: ${Object.keys(PROVIDERS).join(', ')}`);
  return new Impl();
}
