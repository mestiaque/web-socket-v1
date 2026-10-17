# Third-party notices

## Runtime dependencies (shipped)

| Package | Version | License | Notes |
|---|---|---|---|
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT | Only runtime dependency. No transitive dependencies. Optional native add-ons `bufferutil` / `utf-8-validate` are **not** installed. |

`ws` license:

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Development dependencies (not shipped)

| Package | Version | License |
|---|---|---|
| eslint | 9.39.5 | MIT |
| @eslint/js | 9.39.5 | MIT |
| globals | 17.13.0 | MIT |

The development dependency tree (≈115 packages) contains MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC and one Python-2.0 licensed package
(`argparse`, used by ESLint's config tooling). None of them is included in
the production install (`npm ci --omit=dev`) or the Docker image.

The SDK (`sdk/dynamicsocket.js`) has no dependencies.
