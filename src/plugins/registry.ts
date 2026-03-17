/** Plugin registry. Add new plugins here. */

import type { SourcePlugin } from "./base.js";
import { CoinbaseOnePdfPlugin } from "./coinbase-one/pdf-parser.js";
import { CsvImportPlugin } from "./csv-import/index.js";

export const plugins: SourcePlugin[] = [
  new CoinbaseOnePdfPlugin(),
  new CsvImportPlugin(),
];
