// Exact codes listed in the official Yohji Yamamoto Femme Spring/Summer 2021
// runway's numbered Look Details. Repeated appearances are one source record.
const runwayURL = 'https://www.yohjiyamamoto.co.jp/en/collection/femme/spring-summer-2021-yyf/';
const runwayLooks = {
  1: "FD-D15-805-1 FD-E21-770-1",
  2: "FD-D18-805-1",
  3: "FD-D09-805-1 FD-E03-060-2",
  4: "FD-D20-805-1",
  5: "FD-D13-002-1 FD-E01-760-2",
  7: "FD-D14-002-1",
  8: "FD-D11-002-1",
  9: "FD-E03-060-2 FD-J02-200-1 FD-P02-200-1",
  10: "FD-E03-060-2 FD-J08-200-1 FD-P17-200-1",
  11: "FD-E03-060-2 FD-J05-200-1 FD-P02-200-1",
  12: "FD-D03-200-1 FD-E01-760-2",
  13: "FD-E04-060-2 FD-J03-200-1 FD-S02-200-1",
  14: "FD-E04-060-2 FD-J06-200-1 FD-P04-200-1",
  15: "FD-E01-760-2 FD-J07-200-1 FD-P02-200-1",
  16: "FD-E06-860-1 FD-H01-200-1 FD-J09-200-1 FD-P07-200-1",
  17: "FD-H04-200-1 FD-J04-200-1 FD-S07-200-1",
  18: "FD-D19-200-1 FD-E02-761-1 FD-H03-200-1",
  19: "FD-D21-200-1 FD-E04-060-2 FD-H02-200-1",
  20: "FD-E21-770-1 FD-J14-200-1 FD-P17-200-1",
  21: "FD-E22-770-1 FD-J13-200-1 FD-P11-200-1",
  22: "FD-D27-300-1 FD-E21-770-1 FD-J11-300-1",
  23: "FD-D26-300-1 FD-E02-761-1 FD-P01-300-1",
  24: "FD-D07-900-1 FD-D08-900-1 FD-E03-060-2",
  25: "FD-D05-900-1 FD-E06-860-1 FD-S04-900-1",
  26: "FD-D24-900-1 FD-J16-900-1",
  27: "FD-D02-007-1 FD-E02-761-1 FD-P02-200-1 FD-S01-007-1",
  28: "FD-D23-801-1 FD-J15-801-1",
  29: "FD-D01-301-1 FD-E21-770-1 FD-J01-301-1 FD-P06-200-1",
  30: "FD-D22-010-1 FD-P13-010-1",
  31: "FD-D04-802-1 FD-E22-770-1 FD-P20-200-1 FD-S03-900-1",
  32: "FD-A03-960-1 FD-D06-900-1 FD-P08-900-1",
  33: "FD-D28-803-1 FD-D31-304-1 FD-E08-065-1 FD-E09-066-1 FD-E10-862-1 FD-J20-304-1 FD-J21-304-1 FD-P22-803-1 FD-P23-803-1 FD-P24-803-1",
};

const category = { A: 'Accessory', D: 'Dress', E: 'Footwear', H: 'Headwear', J: 'Jacket', P: 'Trousers', S: 'Skirt' };
const codeLooks = new Map();
for (const [look, codes] of Object.entries(runwayLooks)) {
  for (const productCode of codes.split(' ')) {
    if (!codeLooks.has(productCode)) codeLooks.set(productCode, []);
    codeLooks.get(productCode).push(look);
  }
}

export const archiveRecords = [
  ...Array.from(codeLooks, ([productCode, looks]) => ({
    code: productCode.split('-').slice(0, 3).join('-'),
    productCode,
    title: `${category[productCode[3]]} · Spring/Summer 2021`,
    brand: 'Yohji Yamamoto Femme',
    sourceType: 'runway',
    collectionYear: 2021,
    sourceUrl: runwayURL,
    sourceName: `Yohji Yamamoto runway archive · Look ${looks.join(', ')}`,
  })),
  {
    code: 'FJ-J34-109',
    title: 'Cropped zip jacket',
    brand: 'Yohji Yamamoto Femme',
    sourceType: 'resale',
    collectionYear: 2004,
    sourceUrl: 'https://item.rakuten.co.jp/modescape/rc_it80lt8lrajg_90nz/',
    sourceName: 'MODESCAPE resale listing · Tagged Fall/Winter 2004 by seller',
  },
];

/** An archive lead shares the line/season prefix and model, not the full code. */
export function findArchiveLeads(parsed) {
  if (!parsed?.valid || parsed.kind !== 'product') return [];
  const stem = parsed.baseCode.slice(0, -3);
  return archiveRecords.filter((record) => record.code !== parsed.baseCode && record.code.startsWith(stem));
}
