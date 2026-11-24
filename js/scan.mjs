import { normalizeCode } from './lookup.mjs';

const OCR_SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';

function loadOCR() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OCR_SCRIPT;
    script.onload = () => globalThis.Tesseract ? resolve(globalThis.Tesseract) : reject(new Error('OCR unavailable'));
    script.onerror = () => {
      script.remove();
      reject(new Error('OCR unavailable'));
    };
    document.head.append(script);
  });
}

export function readProductCodes(text) {
  const lines = text.normalize('NFKC').toUpperCase().replace(/[\u2010-\u2015\u2212]/g, '-').split(/\r?\n/);
  const codes = new Set();
  for (const line of lines) {
    const matches = line.matchAll(/(?<![A-Z0-9-])[A-Z]{2}(?:\s*-\s*|\s*)[A-Z]\d{2}(?:\s*-\s*|\s*)\d{3}(?:\s*-\s*[A-Z0-9]{1,12}){0,4}(?![A-Z0-9]|\s*-)/g);
    for (const [candidate] of matches) {
      const parsed = normalizeCode(candidate);
      if (parsed.valid) codes.add(parsed.normalized);
    }
  }
  return [...codes];
}

export function setupCodeScanner({ button, photo, input, status }) {
  button.addEventListener('click', () => photo.click());
  photo.addEventListener('change', async () => {
    const file = photo.files[0];
    photo.value = '';
    if (!file) return;

    const originalCode = input.value;
    let worker;
    let timer;
    let expired = false;
    button.disabled = true;
    status.textContent = 'Reading the label photo…';
    try {
      const codes = await Promise.race([
        (async () => {
          const ocr = await loadOCR();
          worker = await ocr.createWorker('eng', 1, {
            workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
            corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
            langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
            errorHandler: () => {},
          });
          if (expired) {
            await worker.terminate();
            return [];
          }
          const { data } = await worker.recognize(file);
          return readProductCodes(data.text);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error('Scan timed out'));
          }, 60000);
        }),
      ]);
      if (codes.length !== 1) {
        status.textContent = codes.length
          ? 'Several codes found. Retake the photo with just one code in view.'
          : 'No product code found. Try a closer, well-lit photo or type the code.';
      } else if (input.value !== originalCode) {
        status.textContent = 'Detected ' + codes[0] + '. Your current entry was kept.';
      } else {
        input.value = codes[0];
        input.dispatchEvent(new Event('input', { bubbles: true }));
        status.textContent = 'Check the detected code against the label, then select Lookup.';
      }
    } catch {
      status.textContent = 'Could not scan this photo. Try another photo or type the code.';
    } finally {
      clearTimeout(timer);
      if (worker) await worker.terminate().catch(() => {});
      button.disabled = false;
    }
  });
}
