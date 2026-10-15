# PDFGeek: PDF Tools

Merge, split, reorder, rotate and password protect PDFs, and turn pictures into PDFs, all inside your browser. Your files are never uploaded anywhere.

**Download and full guide:** https://techygeekshome.info/browser-extensions/pdfgeek/

## What it does

Click the PDFGeek icon and a PDFGeek tab opens with these tools:

- **Merge**: add two or more PDFs, drag them into order, and join them into one file.
- **Split**: save every page as its own file, pick ranges such as `1-3, 5, 8-`, or start a new file every few pages. Several files come in one ZIP.
- **Organise pages**: see every page, drag pages into a new order, turn them the right way up and remove the ones you do not need.
- **Images to PDF**: JPG, PNG and WebP pictures, one per page, on A4, Letter or a page the same size as the picture, with or without margins. Phone photos are turned the right way up, and JPG photos go in as they are, with no loss of quality.
- **Add a password**: lock a PDF with AES-256, the strongest encryption PDFs support. It opens in any modern PDF reader, and only with the password (tested with the PDF readers built into Chrome, Edge and Firefox, plus poppler and qpdf).
- **Remove a password**: when you know the password, save a copy that opens without it.
- **Shrink**: repacks the file without touching its quality. It only saves the file if it gets smaller.
- **Open in PDFGeek** on the right-click menu of PDF links. PDFGeek asks for your OK to read that one site the first time.

## What it won't do

- It never uploads your files. There is no PDFGeek server.
- It does not lower picture quality to make files smaller, so scanned PDFs and photo-heavy files will not shrink much.
- It does not edit the text of a PDF, fill in forms or add signatures.
- It cannot remove a password you do not know.

## Install

Pick the download for your browser from the [latest release](https://github.com/techygeekshome/PDFGeek/releases/latest).

| Browser | Download |
|---|---|
| Chrome, Brave, Opera, Vivaldi | `PDFGeek-chrome.zip` |
| Microsoft Edge | `PDFGeek-edge.zip` |
| Firefox (142 or newer) | `PDFGeek-firefox.zip` |

`PDFGeek.zip` is the same package as the Chrome and Edge downloads.

### Chrome, Edge, Brave, Opera and Vivaldi

1. Unzip the download somewhere you'll keep it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `pdfgeek` folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `PDFGeek-firefox.zip`.

Firefox removes temporary add-ons when it closes.

### Build it yourself

The code in this repo is the Chromium version. `manifest.firefox.json` is the Firefox manifest. Run `./build.sh` to make every package in `dist/`.

## Use

1. Click the PDFGeek icon. The PDFGeek tab opens (clicking again takes you back to it).
2. Pick a tool on the left.
3. Drop your files on the box, or click **choose files**.
4. Press the red button. The new file is saved to your Downloads folder with a clear name, such as `report-merged.pdf`, `report-pages-1-3.pdf` or `report-protected.pdf`.

If you add a PDF that has a password, PDFGeek asks for it, unlocks the file for that job, and leaves your original file alone.

## How it works

- `app.html` and `app.js` hold every tool. Files are read with the browser's File API and stay in the memory of that tab.
- Merging, splitting, page changes and pictures use [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1.
- Page previews are drawn with [PDF.js](https://github.com/mozilla/pdf.js) 4.10.38, Mozilla's PDF reader, a few pages at a time as you scroll, so 200-page files open quickly.
- Passwords and shrinking use [qpdf](https://github.com/qpdf/qpdf) 12.2.0 compiled to WebAssembly ([qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) 0.3.0), running in a worker (`qpdf-worker.js`). Encryption is AES-256 (PDF 2.0, revision 6). WebAssembly needs `'wasm-unsafe-eval'` in the extension's content security policy; scripts still only load from the extension itself.
- All three libraries are bundled, unchanged, in `lib/`. Versions, sources, checksums and licences are in `lib/LICENSES.txt`. Nothing is loaded from the internet.
- `background.js` only opens the PDFGeek tab and adds the right-click menu item.
- Files are saved with a normal browser download, so no downloads permission is needed.

## Permissions

- `storage`: remembers the last tool you used and your Images to PDF choices.
- `contextMenus`: adds **Open in PDFGeek** to the right-click menu on PDF links.
- Optional site access: asked for one site at a time, only when you use **Open in PDFGeek** on a link, so PDFGeek can download that PDF. Never asked at install.

## Privacy

PDFGeek has no account, no analytics and no server. It never uploads, shares or keeps your files: they are read and written inside your browser tab and are gone when you close it. The only time it goes online is to download a PDF you asked it to open from a link.

## Licence

GPL-3.0. Free for everyone, including commercial use. The bundled libraries keep their own licences (MIT for pdf-lib, Apache-2.0 for PDF.js and qpdf, ISC for qpdf-wasm).

PDFGeek is an independent tool made by [TechyGeeksHome](https://techygeekshome.info).
