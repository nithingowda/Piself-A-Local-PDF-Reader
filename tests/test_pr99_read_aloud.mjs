import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const staticRoot = new URL('../static/', import.meta.url);
const app = readFileSync(new URL('app.js', staticRoot), 'utf8');
const speech = readFileSync(new URL('read-aloud.js', staticRoot), 'utf8');
const html = readFileSync(new URL('index.html', staticRoot), 'utf8');

test('PR #99 automatic PDF read-aloud is restored without manual queue', () => {
  assert.match(app, /async function readPdfFromTap\(event\)/);
  assert.match(app, /async function startPdfSpeech\(\)/);
  assert.match(app, /orderPdfSpeechItems\(content\.items/);
  assert.match(app, /pdfSpeechText\(ordered\.slice\(start\)\)/);
  assert.match(app, /showPdfSpeechPage\(pdfSpeechPage\)/);
  assert.doesNotMatch(app, /speechQueues=\{pdf:\[\],epub:\[\]\}/);
  assert.doesNotMatch(html, /speech-queue-panel/);
  assert.equal(existsSync(new URL('manual-read-queue.js', staticRoot)), false);
});

test('PR #99 maintains Edge sentence timing and next-page prefetch without playback highlights', () => {
  assert.match(speech, /speechSentenceRanges\(chunk,ready\.sentences\)/);
  assert.match(speech, /nextPagePrefetch=preloadNextPage\(\)/);
  assert.match(speech, /peekNextText\(\)/);
  assert.match(app, /async peekNextText\(\)/);
  const notify = new Function('return (' + app.slice(app.indexOf('function speechState('), app.indexOf('// One-shot starting positions')).trim() + ')')();
  assert.doesNotThrow(() => notify('pdf', {spokenText:'sample',readingOffset:0,readingLength:6}));
  assert.doesNotThrow(() => notify('epub', {spokenText:'sample'}));
});

test('PR #99 finishes all Physics columns before lower Health article', async () => {
  const { orderPdfSpeechItems } = await import('../static/pdf-reading-order.js');
  const viewport = {width: 700, height: 890, convertToViewportPoint: (x, y) => [x, y]};
  const part = (str, x, y, height = 12) => ({
    str, transform: [1, 0, 0, 1, x, y], width: 140, height
  });
  const items = [
    part('Physics', 25, 38, 9),
    part('First quantum clock that ticks using sunlight', 25, 65, 23),
    part('Physics research by scientists.', 25, 110, 10)
  ];
  for (let i = 0; i < 23; i++) {
    for (const [column, x] of [25, 190, 355, 520].entries()) {
      items.push(part('Physics column '+(column+1)+' line '+(i+1)+'.', x, 155+i*16));
    }
  }
  items.push(part('Health', 25, 580, 9));
  items.push(part('Pink noise may ease memory loss', 25, 605, 23));
  for (let i = 0; i < 9; i++) {
    for (const [column, x] of [25, 190, 355, 520].entries()) {
      items.push(part('Health column '+(column+1)+' line '+(i+1)+'.', x, 675+i*16));
    }
  }
  // Content-stream order is not visual order.
  const ordered = orderPdfSpeechItems(items.reverse(), viewport).map(row => row.str);
  const at = label => ordered.indexOf(label);
  assert.ok(at('Physics column 1 line 23.') < at('Physics column 2 line 1.'));
  assert.ok(at('Physics column 2 line 23.') < at('Physics column 3 line 1.'));
  assert.ok(at('Physics column 3 line 23.') < at('Physics column 4 line 1.'));
  assert.ok(at('Physics column 4 line 23.') < at('Health'));
  assert.ok(at('Health column 1 line 9.') < at('Health column 2 line 1.'));
});
