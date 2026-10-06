# Fylane SDKs

Official clients for [Fylane](https://fylane.dev) — file conversion and fixing for PDFs, images, documents, audio and video. One call uploads a file, runs an operation and returns the result; the same engine powers the [free tools](https://fylane.dev/tools) on fylane.dev, which run on your device wherever the browser can do the work.

| Package | Install | For |
| --- | --- | --- |
| [`@fylane/node`](https://www.npmjs.com/package/@fylane/node) | `npm i @fylane/node` | Node.js servers and scripts |
| [`@fylane/browser`](https://www.npmjs.com/package/@fylane/browser) | `npm i @fylane/browser` | Browsers, with on-device fixes before upload |
| [`@fylane/react`](https://www.npmjs.com/package/@fylane/react) | `npm i @fylane/react` | React hooks and an upload component |
| [`fylane`](https://pypi.org/project/fylane/) | `pip install fylane` | Python |

```ts
import { Fylane } from '@fylane/node';

const fylane = new Fylane(process.env.FYLANE_API_KEY);
const job = await fylane.files.process('./report.docx', { operation: 'convert' });
console.log(job.state, job.artifacts);
```

```py
from fylane import Fylane

job = Fylane(api_key).files.process("report.docx", operation="convert")
print(job.state, job.artifacts)
```

- Website: https://fylane.dev
- Quickstart and API reference: https://fylane.dev/docs/quickstart
- Free tools (PDF, images, documents, audio, video): https://fylane.dev/tools
- Chrome extension that fixes files inside any upload form: https://fylane.dev/extension

Each directory holds one package with its own README and tests: [`node/`](node), [`browser/`](browser), [`react/`](react), [`python/`](python).

MIT © Fylane
