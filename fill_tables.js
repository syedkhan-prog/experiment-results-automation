const doc = $input.first().json || {};
const spec = $('Build Bolt Report').item.json.tables || [];
if (!spec.length) return [{ json: { requests: [] } }];

const docTables = [];
for (const element of (doc.body && doc.body.content) || []) {
  if (element.table) docTables.push(element.table);
}
if (docTables.length !== spec.length) {
  throw new Error('Expected ' + spec.length + ' tables in the document but found ' + docTables.length);
}

const cells = [];
docTables.forEach((table, tableIdx) => {
  const values = [spec[tableIdx].headers, ...spec[tableIdx].rows];
  (table.tableRows || []).forEach((row, rowIdx) => {
    (row.tableCells || []).forEach((cell, colIdx) => {
      const value = String(((values[rowIdx] || [])[colIdx]) ?? '');
      const start = cell.content && cell.content[0] ? cell.content[0].startIndex : null;
      if (start == null || !value) return;
      cells.push({ index: start, text: value, isHeader: rowIdx === 0 });
    });
  });
});

cells.sort((a, b) => a.index - b.index);

let shift = 0;
for (const cell of cells) {
  cell.finalIndex = cell.index + shift;
  shift += cell.text.length;
}

const requests = [];
for (const cell of [...cells].reverse()) {
  requests.push({ insertText: { location: { index: cell.index }, text: cell.text } });
}
for (const cell of cells) {
  requests.push({
    updateTextStyle: {
      range: { startIndex: cell.finalIndex, endIndex: cell.finalIndex + cell.text.length },
      textStyle: {
        weightedFontFamily: { fontFamily: 'Inter' },
        fontSize: { magnitude: 8.5, unit: 'PT' },
        bold: cell.isHeader,
        foregroundColor: { color: { rgbColor: cell.isHeader ? { red: 0.08, green: 0.28, blue: 0.2 } : { red: 0.09, green: 0.17, blue: 0.14 } } },
      },
      fields: 'weightedFontFamily,fontSize,bold,foregroundColor',
    },
  });
}

return [{ json: { requests } }];
