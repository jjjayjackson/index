const STORAGE_KEY = "index";
const TABLE = "index_documents";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const supabase = window.supabase.createClient(
  window.INDEX_SUPABASE.url,
  window.INDEX_SUPABASE.anonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  },
);

const listEl = document.getElementById("list");
const addEl = document.getElementById("add");
const menuEl = document.getElementById("menu");
const statusEl = document.getElementById("status");

let documents = [];
let ready = false;
let cloudQueue = Promise.resolve(true);
let freshIds = new Set();
let editing = null;
let editSnapshot = null;
let menuContext = null;

function newId() {
  return crypto.randomUUID();
}

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function normalizeNote(note) {
  return {
    id: isUuid(note.id) ? note.id : newId(),
    text: typeof note.text === "string" ? note.text : "",
  };
}

function normalizeDoc(doc) {
  const notes = Array.isArray(doc.notes) ? doc.notes : [];
  return {
    id: isUuid(doc.id) ? doc.id : newId(),
    title: typeof doc.title === "string" ? doc.title : "",
    number: typeof doc.number === "string" ? doc.number : "",
    notes: notes.filter((note) => note && typeof note === "object").map(normalizeNote),
  };
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((doc) => doc && typeof doc === "object").map(normalizeDoc);
  } catch {
    return [];
  }
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
}

function toRow(doc, index) {
  return {
    id: doc.id,
    title: doc.title,
    number: doc.number,
    notes: doc.notes.map((note) => ({ id: note.id, text: note.text })),
    position: index,
  };
}

function enqueue(task) {
  const run = cloudQueue.then(task, task);
  cloudQueue = run.then(
    (ok) => ok !== false,
    () => false,
  );
  return run;
}

function saveCloud() {
  return enqueue(async () => {
    if (!documents.length) return true;
    const { error } = await supabase.from(TABLE).upsert(documents.map(toRow));
    if (error) {
      console.error(error);
      return false;
    }
    return true;
  });
}

function deleteCloud(id) {
  return enqueue(async () => {
    const { error } = await supabase.from(TABLE).delete().eq("id", id);
    if (error) {
      console.error(error);
      return false;
    }
    if (documents.length) {
      const { error: orderError } = await supabase.from(TABLE).upsert(documents.map(toRow));
      if (orderError) {
        console.error(orderError);
        return false;
      }
    }
    return true;
  });
}

async function loadCloud() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, title, number, notes, position")
    .order("position", { ascending: true });
  if (error) throw error;
  return (data || []).map(normalizeDoc);
}

function mergeDocuments(cloud, local) {
  const ids = new Set(cloud.map((doc) => doc.id));
  const merged = cloud.slice();
  for (const doc of local) {
    if (!ids.has(doc.id)) merged.push(doc);
  }
  return merged;
}

function save() {
  saveLocal();
  return saveCloud();
}

function findDoc(id) {
  return documents.find((doc) => doc.id === id);
}

function readValue(doc, target, noteId) {
  if (target === "title") return doc.title;
  if (target === "number") return doc.number;
  const note = doc.notes.find((item) => item.id === noteId);
  return note ? note.text : "";
}

function writeValue(doc, target, noteId, value) {
  if (target === "title") doc.title = value;
  else if (target === "number") doc.number = value;
  else {
    const note = doc.notes.find((item) => item.id === noteId);
    if (note) note.text = value;
  }
}

function hideMenu() {
  menuEl.hidden = true;
  menuContext = null;
}

function focusField(field) {
  requestAnimationFrame(() => {
    field.focus();
    const end = field.value.length;
    if (typeof field.setSelectionRange === "function") field.setSelectionRange(end, end);
  });
}

function settle() {
  if (!editing) return;
  editing = null;
  editSnapshot = null;
  save();
}

function cancelEdit() {
  if (!editing) return;
  const { docId, target, noteId, fresh } = editing;
  const doc = findDoc(docId);
  if (fresh && target === "title") {
    documents = documents.filter((item) => item.id !== docId);
  } else if (fresh && target === "note" && doc) {
    doc.notes = doc.notes.filter((note) => note.id !== noteId);
  } else if (doc) {
    writeValue(doc, target, noteId, editSnapshot ?? "");
  }
  editing = null;
  editSnapshot = null;
  save();
  render();
}

function showMark(marker) {
  const row = listEl.querySelector(`[data-id="${CSS.escape(marker.docId)}"]`);
  if (!row) return;
  let anchor = null;
  if (marker.target === "title") anchor = row.querySelector(".title-line");
  else if (marker.target === "number") anchor = row.querySelector(".number-slot");
  else if (marker.noteId) {
    anchor = row.querySelector(`[data-note-id="${CSS.escape(marker.noteId)}"] .note-line`);
  }
  if (!anchor) return;
  anchor.querySelector(".mark")?.remove();
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = "saved";
  mark.setAttribute("aria-hidden", "true");
  anchor.append(mark);
  mark.addEventListener("animationend", () => mark.remove());
}

function commitEnter() {
  if (!editing) return;
  const marker = {
    docId: editing.docId,
    target: editing.target,
    noteId: editing.noteId,
  };
  editing = null;
  editSnapshot = null;
  save();
  render();
  showMark(marker);
  statusEl.textContent = "Saved.";
}

function beginEdit(docId, target, noteId, fresh) {
  if (editing && (editing.docId !== docId || editing.target !== target || editing.noteId !== (noteId || null))) {
    settle();
  }
  const doc = findDoc(docId);
  if (!doc) return;
  if (target === "note" && !doc.notes.some((note) => note.id === noteId)) return;
  editSnapshot = fresh ? "" : readValue(doc, target, noteId);
  editing = { docId, target, noteId: noteId || null, fresh: Boolean(fresh) };
  hideMenu();
  render();
}

function addDocument() {
  settle();
  const doc = { id: newId(), title: "", number: "", notes: [] };
  freshIds.add(doc.id);
  documents.push(doc);
  save();
  render();
  const input = listEl.querySelector(`[data-id="${CSS.escape(doc.id)}"] .title-input`);
  if (input) focusField(input);
}

function addComment(docId) {
  settle();
  const doc = findDoc(docId);
  if (!doc) return;
  const note = { id: newId(), text: "" };
  doc.notes.push(note);
  save();
  beginEdit(docId, "note", note.id, true);
}

function removeDoc(docId) {
  freshIds.delete(docId);
  if (editing?.docId === docId) {
    editing = null;
    editSnapshot = null;
  }
  documents = documents.filter((doc) => doc.id !== docId);
  saveLocal();
  deleteCloud(docId);
  render();
}

function removeNote(docId, noteId) {
  const doc = findDoc(docId);
  if (!doc) return;
  if (editing?.docId === docId && editing.noteId === noteId) {
    editing = null;
    editSnapshot = null;
  }
  doc.notes = doc.notes.filter((note) => note.id !== noteId);
  save();
  render();
}

function showMenu(x, y, context) {
  menuContext = context;
  menuEl.querySelector('[data-action="edit"]').hidden = context.target !== "note";
  menuEl.querySelector('[data-action="comment"]').hidden = context.target !== "title";
  menuEl.querySelector('[data-action="delete"]').hidden = false;
  menuEl.hidden = false;
  const margin = 8;
  const rect = menuEl.getBoundingClientRect();
  let top = y;
  let left = x;
  if (top + rect.height > window.innerHeight - margin) top = y - rect.height;
  if (top < margin) top = Math.max(margin, window.innerHeight - margin - rect.height);
  if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - margin - rect.width;
  if (left < margin) left = margin;
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${left}px`;
}

function openMenu(event, context) {
  event.preventDefault();
  showMenu(event.clientX, event.clientY, context);
}

function fieldInput(doc, target, noteId, value, label) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = target === "note" ? "note-input" : target === "number" ? "number-input" : "title-input";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.spellcheck = target !== "number";
  input.enterKeyHint = "done";
  if (target === "number") input.inputMode = "numeric";
  input.addEventListener("input", () => {
    const entry = findDoc(doc.id);
    if (!entry) return;
    writeValue(entry, target, noteId, input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const entry = findDoc(doc.id);
    if (!entry) return;
    writeValue(entry, target, noteId, input.value);
    commitEnter();
  });
  focusField(input);
  return input;
}

function rowEl(doc) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.id = doc.id;

  const titleSlot = document.createElement("div");
  titleSlot.className = "title-slot";
  const titleLine = document.createElement("div");
  titleLine.className = "title-line";
  titleLine.append(titleField(doc));
  titleSlot.append(titleLine);
  titleSlot.addEventListener("contextmenu", (event) => {
    openMenu(event, { docId: doc.id, target: "title", noteId: null });
  });

  const numberSlot = document.createElement("div");
  numberSlot.className = "number-slot";
  numberSlot.append(numberField(doc));

  li.append(titleSlot, numberSlot);

  if (doc.notes.length) {
    const notes = document.createElement("ul");
    notes.className = "notes";
    for (const note of doc.notes) notes.append(noteEl(doc, note));
    li.append(notes);
  }

  return li;
}

function titleField(doc) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "title-input";
  input.value = doc.title;
  input.setAttribute("aria-label", "Document");
  input.autocomplete = "off";
  input.enterKeyHint = "done";
  let snapshot = doc.title;

  input.addEventListener("focus", () => {
    snapshot = input.value;
  });
  input.addEventListener("input", () => {
    const entry = findDoc(doc.id);
    if (!entry) return;
    entry.title = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (freshIds.has(doc.id)) {
        freshIds.delete(doc.id);
        removeDoc(doc.id);
        return;
      }
      const entry = findDoc(doc.id);
      if (entry) entry.title = snapshot;
      input.value = snapshot;
      input.blur();
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const entry = findDoc(doc.id);
    if (!entry) return;
    entry.title = input.value;
    snapshot = input.value;
    freshIds.delete(doc.id);
    save();
    showMark({ docId: doc.id, target: "title", noteId: null });
    statusEl.textContent = "Saved.";
    input.blur();
  });
  return input;
}

function numberField(doc) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "number-input";
  input.value = doc.number;
  input.placeholder = "–";
  input.setAttribute("aria-label", "Number");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.inputMode = "numeric";
  input.enterKeyHint = "done";
  let snapshot = doc.number;

  input.addEventListener("focus", () => {
    snapshot = input.value;
  });
  input.addEventListener("input", () => {
    const entry = findDoc(doc.id);
    if (!entry) return;
    entry.number = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const entry = findDoc(doc.id);
      if (entry) entry.number = snapshot;
      input.value = snapshot;
      input.blur();
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const entry = findDoc(doc.id);
    if (!entry) return;
    entry.number = input.value;
    snapshot = input.value;
    save();
    showMark({ docId: doc.id, target: "number", noteId: null });
    statusEl.textContent = "Saved.";
    input.blur();
  });
  return input;
}

function noteEl(doc, note) {
  const li = document.createElement("li");
  li.className = "note";
  li.dataset.noteId = note.id;

  const line = document.createElement("div");
  line.className = "note-line";

  if (editing?.docId === doc.id && editing.target === "note" && editing.noteId === note.id) {
    line.append(fieldInput(doc, "note", note.id, note.text, "Comment"));
  } else {
    const view = document.createElement("div");
    view.className = "note-view";
    view.textContent = note.text;
    line.append(view);
    li.addEventListener("contextmenu", (event) => {
      openMenu(event, { docId: doc.id, target: "note", noteId: note.id });
    });
  }

  li.append(line);
  return li;
}

function render() {
  hideMenu();
  listEl.replaceChildren();
  for (const doc of documents) listEl.append(rowEl(doc));
}

addEl.addEventListener("click", () => {
  if (!ready) return;
  addDocument();
});

menuEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !menuContext) return;
  const { docId, target, noteId } = menuContext;
  const action = button.dataset.action;
  hideMenu();
  if (action === "edit") beginEdit(docId, target, noteId, false);
  else if (action === "comment") addComment(docId);
  else if (action === "delete" && target === "note") removeNote(docId, noteId);
  else if (action === "delete") removeDoc(docId);
});

document.addEventListener("pointerdown", (event) => {
  if (menuEl.hidden || menuEl.contains(event.target)) return;
  hideMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || menuEl.hidden) return;
  hideMenu();
});

window.addEventListener("resize", hideMenu);
window.addEventListener("scroll", hideMenu, true);

async function boot() {
  const local = loadLocal();
  try {
    const cloud = await loadCloud();
    documents = mergeDocuments(cloud, local);
    saveLocal();
    if (documents.length !== cloud.length) await saveCloud();
  } catch (error) {
    console.error(error);
    documents = local;
  }
  ready = true;
  render();
}

boot();
