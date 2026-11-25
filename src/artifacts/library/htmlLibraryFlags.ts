export type HtmlLibraryFlag = {
  name: string;
  version: string;
  needsEval: boolean;
  assets: boolean;
};

export const HTML_LIBRARY_FLAGS: readonly HtmlLibraryFlag[] = [
  { name: "chartjs", version: "4.6.2", needsEval: false, assets: false },
  { name: "d3", version: "7.9.2", needsEval: false, assets: false },
  { name: "echarts", version: "6.1.0", needsEval: false, assets: false },
  { name: "leaflet", version: "1.9.4", needsEval: false, assets: true },
  { name: "mermaid", version: "12.3.0", needsEval: true, assets: false },
];
