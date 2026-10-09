/* =========================================================
   db.js – local database (IndexedDB)

   Object stores ("tables"):
     settings   { key: 'main', ...settings }
     docs       { id, name, pageIds: [ordered page ids], thumb (data URL of page 1),
                  createdAt, modifiedAt }
     pages      { id, docId, corners: [{x,y} ×4, fractions 0–1 of the original photo, TL,TR,BR,BL],
                  filter ('original'|'color'|'grey'|'bw'), rotation (0/90/180/270),
                  width, height (of the finished page image), thumb (data URL), createdAt }
     pageImages { id (same as the page's id), docId,
                  original (Blob – the photo as taken, so the page can be re-cropped),
                  processed (Blob – the flattened, filtered page that goes in the PDF) }
                  – kept separate so lists don't load the large images

   Page order lives in docs.pageIds. Changes that touch several records
   (adding a page, deleting a document) run in ONE transaction: either
   everything succeeds or nothing changes.
   ========================================================= */

const DB = (() => {
  const DB_NAME = 'scanner';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support local storage (IndexedDB).'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('docs')) {
          db.createObjectStore('docs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('pages')) {
          const s = db.createObjectStore('pages', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
        }
        if (!db.objectStoreNames.contains('pageImages')) {
          const s = db.createObjectStore('pageImages', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another tab upgrades the database, close this connection cleanly.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database is blocked. Close other tabs of this app and try again.'));
    });
    return dbPromise;
  }

  /**
   * Run `work(stores)` inside one transaction. `work` must only issue IndexedDB
   * requests synchronously (no awaiting other promises), otherwise the transaction
   * would auto-commit early. Resolves when the transaction has fully committed.
   * If `work` returns an IDBRequest, the promise resolves with that request's result.
   */
  async function run(storeNames, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = {};
      [].concat(storeNames).forEach(n => { stores[n] = tx.objectStore(n); });
      let out;
      try {
        out = work(stores, tx);
      } catch (err) {
        try { tx.abort(); } catch (e) { /* already finished */ }
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Database transaction was cancelled (is the phone out of storage?).'));
    });
  }

  // ---------- Simple helpers ----------
  const get = (store, key) => run(store, 'readonly', s => s[store].get(key));
  const getAll = (store) => run(store, 'readonly', s => s[store].getAll());
  const getAllByIndex = (store, index, value) =>
    run(store, 'readonly', s => s[store].index(index).getAll(value));
  const put = (store, obj) => run(store, 'readwrite', s => { s[store].put(obj); return obj; });

  /** Delete every record in `store` whose `index` equals `value` (inside an open transaction). */
  function deleteByIndex(storeObj, index, value) {
    const req = storeObj.index(index).openCursor(IDBKeyRange.only(value));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
  }

  // ---------- Documents & pages ----------
  /** Pages of a document, in document order. */
  async function getPages(doc) {
    const pages = await getAllByIndex('pages', 'docId', doc.id);
    const byId = new Map(pages.map(p => [p.id, p]));
    return doc.pageIds.map(id => byId.get(id)).filter(Boolean);
  }

  /** Save a page (record + images) and the updated document together. */
  function savePage({ doc, page, images }) {
    return run(['docs', 'pages', 'pageImages'], 'readwrite', s => {
      s.pages.put(page);
      if (images) s.pageImages.put(images);
      s.docs.put(doc);
      return page;
    });
  }

  function deletePage(doc, pageId) {
    return run(['docs', 'pages', 'pageImages'], 'readwrite', s => {
      s.pages.delete(pageId);
      s.pageImages.delete(pageId);
      s.docs.put(doc);
    });
  }

  function deleteDoc(docId) {
    return run(['docs', 'pages', 'pageImages'], 'readwrite', s => {
      deleteByIndex(s.pageImages, 'docId', docId);
      deleteByIndex(s.pages, 'docId', docId);
      s.docs.delete(docId);
    });
  }

  return {
    open, run, get, getAll, getAllByIndex, put,
    getPages, savePage, deletePage, deleteDoc
  };
})();
