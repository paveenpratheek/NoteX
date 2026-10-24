/* A small fabric shaped like File Fabric's own fabric.json, with one of
 * each thing NoteX has a rule for. Coordinates are File Fabric's world
 * units; y grows downward. */
export const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

export function sampleState() {
  return {
    totems: [
      { id: 'T1', name: 'RESEARCH', x: 0, y: -100, radius: 0 },
      { id: 'T2', name: 'HOME', x: 5000, y: -100, radius: 0 },
    ],
    areas: [
      // RESEARCH > GAP PAPERS > LITERATURE SURVEY, with a note inside the survey.
      { id: 'A1', name: 'GAP PAPERS', polygons: [rect(0, 0, 1000, 800)], parentAreaId: null, linkedTotemId: 'T1' },
      { id: 'A2', name: 'LITERATURE SURVEY', polygons: [rect(50, 50, 400, 300)], parentAreaId: 'A1', linkedTotemId: 'T1' },
      { id: 'N1', name: 'SURVEY TODO', isNote: true, textContent: '# Reading\n- [x] SAR review\n- [ ] LISS-4 ratios\n```', polygons: [rect(60, 60, 100, 100)], parentAreaId: 'A2', linkedTotemId: 'T1' },
      // Two siblings with one name.
      { id: 'A3', name: 'METHODS', polygons: [rect(500, 50, 200, 200)], parentAreaId: 'A1', linkedTotemId: 'T1' },
      { id: 'A4', name: 'METHODS', polygons: [rect(500, 400, 200, 200)], parentAreaId: 'A1', linkedTotemId: 'T1' },
      // Reached by RESEARCH's field only through GAP PAPERS beside it (1200 away from the totem).
      { id: 'A5', name: 'DATASETS', polygons: [rect(1200, 0, 300, 300)], parentAreaId: null, linkedTotemId: 'T1' },
      // A scroll box with two pages; something on a third page that was deleted.
      {
        id: 'S1', name: 'Dashboard', type: 'scroll_box', isScrollBox: true, points: rect(5000, 0, 600, 400),
        layout: 'horizontal', pages: [{ id: 'P1' }, { id: 'P2' }], currentPageIndex: 0, parentAreaId: null, linkedTotemId: 'T2',
      },
      { id: 'N2', name: 'Week', isNote: true, textContent: '- [x] a\n- [x] b\n- [ ] c', polygons: [rect(5050, 50, 100, 100)], parentAreaId: 'S1', scrollBoxPageId: 'P2', linkedTotemId: 'T2' },
      { id: 'N3', name: 'Lost', isNote: true, textContent: '- [ ] gone', polygons: [rect(5200, 50, 100, 100)], parentAreaId: 'S1', scrollBoxPageId: 'P9', linkedTotemId: 'T2' },
      // Progress is joined to GAP PAPERS by a link, and to the survey by a drawn line.
      { id: 'A6', name: 'Progress', polygons: [rect(5000, 600, 300, 300)], parentAreaId: null, linkedTotemId: 'T2' },
      // A book and a folder: not places, and nothing in them is read.
      { id: 'B1', name: 'Shelf', isBook: true, polygons: [rect(3000, 0, 200, 200)], parentAreaId: null, linkedTotemId: null },
      { id: 'B2', name: 'Inside the shelf', polygons: [rect(3010, 10, 50, 50)], parentAreaId: 'B1', linkedTotemId: null },
      { id: 'F1', name: 'Box', isFolder: true, type: 'folder', polygons: [rect(3500, 0, 200, 200)], parentAreaId: null, linkedTotemId: null },
      // Saved before File Fabric wrote parentAreaId: NoteX finds its parent itself.
      { id: 'A7', name: 'OLD CORNER', polygons: [rect(600, 650, 100, 100)], linkedTotemId: 'T1' },
    ],
    links: [
      { id: 'L1', fromAreaId: 'A6', fromCorner: 'tl', toAreaId: 'A1', toCorner: 'br' },
    ],
    drawings: [
      { id: 'D1', type: 'text', text: '<font style="font-size: 20px;">Need for <b>ortho</b>rectification</font><br>&amp; more', x: 100, y: 500, areaId: 'A1', linkedTotemId: 'T1' },
      { id: 'D2', type: 'path', points: [{ x: 100, y: 200 }, { x: 110, y: 210 }, { x: 120, y: 205 }], areaId: 'A2', linkedTotemId: 'T1' },
      { id: 'D3', type: 'path', points: [{ x: 5100, y: 100 }, { x: 5110, y: 110 }], areaId: 'S1', scrollBoxPageId: 'P1', linkedTotemId: 'T2' },
      { id: 'D4', type: 'draw', start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, areaId: null, linkedTotemId: null },
      { id: 'D5', type: 'path', points: [{ x: 10, y: 10 }], areaId: 'A1', linkedTotemId: 'T1' },
      { id: 'D6', type: 'line', start: { x: 5100, y: 700 }, end: { x: 100, y: 100 }, areaId: null, linkedTotemId: null },
      { id: 'D7', type: 'progress_bar', x: 5100, y: 650, areaId: 'A6', linkedTotemId: 'T2' },
      { id: 'D8', type: 'text', text: 'loose words', x: 9000, y: 9000, areaId: null, linkedTotemId: null },
    ],
    files: [
      { id: 'F-a', name: 'survey-2024.pdf', isPdf: true, x: 200, y: 200, areaId: 'A2', linkedTotemId: 'T1' },
      { id: 'F-b', name: 'week.png', isImage: true, x: 5300, y: 100, areaId: 'S1', scrollBoxPageId: 'P2', linkedTotemId: 'T2' },
      { id: 'F-c', name: 'hidden.pdf', isPdf: true, isHidden: true, x: 0, y: 0, areaId: null },
      { id: 'F-d', name: 'near-totem.pdf', isPdf: true, x: 20, y: -300, areaId: null, linkedTotemId: 'T1' },
    ],
    tables: [],
  };
}

export const sampleFabric = () => ({ name: 'Thesis', dir: null, modified: '2026-10-24T10:00:00.000Z', state: sampleState(), sources: new Set(['survey-2024.pdf']) });
