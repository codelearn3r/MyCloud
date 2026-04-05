/* ============================================================
   MyCloud — Full-Featured Application
   Upload, Edit, Organize, and Retrieve your photos
   ============================================================ */

(function () {
    "use strict";

    // ─── State ──────────────────────────────────────────────
    const state = {
        photos: [],
        albums: [],
        currentView: "photos",
        selectMode: false,
        selected: new Set(),
        gridMode: "default",
        lightboxIndex: -1,
        searchQuery: "",
        filterChip: "all",
        pendingUploads: [],
        editingPhoto: null,
        MAX_STORAGE: 1 * 1024 * 1024 * 1024 * 1024, // 1 TB
    };

    // ─── DOM ────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const DOM = {};

    function cacheDom() {
        DOM.sidebar = $("#sidebar");
        DOM.menuToggle = $("#menu-toggle");
        DOM.mainContent = $("#main-content");
        DOM.searchInput = $("#search-input");
        DOM.searchClear = $("#search-clear");
        DOM.photoGrid = $("#photo-grid");
        DOM.emptyState = $("#empty-state");
        DOM.lightbox = $("#lightbox");
        DOM.lightboxImg = $("#lightbox-img");
        DOM.lightboxDate = $("#lightbox-date");
        DOM.uploadModal = $("#upload-modal");
        DOM.albumModal = $("#album-modal");
        DOM.dropZone = $("#drop-zone");
        DOM.fileInput = $("#file-input");
        DOM.uploadPreview = $("#upload-preview");
        DOM.btnConfirmUpload = $("#btn-confirm-upload");
        DOM.btnConfirmAlbum = $("#btn-confirm-album");
        DOM.albumNameInput = $("#album-name-input");
        DOM.selectionToolbar = $("#selection-toolbar");
        DOM.selectionCount = $("#selection-count");
        DOM.storageFill = $("#storage-fill");
        DOM.storageText = $("#storage-text");
        DOM.toastContainer = $("#toast-container");
        DOM.editModal = $("#edit-modal");
    }

    // ─── IndexedDB Storage (supports large files) ───────────
    const DB_NAME = "MyCloudDB";
    const DB_VERSION = 1;
    const STORE_PHOTOS = "photos";
    const STORE_META = "metadata";
    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains(STORE_PHOTOS)) {
                    database.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains(STORE_META)) {
                    database.createObjectStore(STORE_META, { keyPath: "key" });
                }
            };
            request.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function dbPut(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            tx.objectStore(storeName).put(data);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGet(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readonly");
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readonly");
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbDelete(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            tx.objectStore(storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    // ─── Save & Load ────────────────────────────────────────
    async function save() {
        try {
            // Save photo metadata (without src data to keep it fast)
            const metaPhotos = state.photos.map((p) => ({
                id: p.id,
                name: p.name,
                size: p.size,
                width: p.width,
                height: p.height,
                date: p.date,
                favorite: p.favorite,
                archived: p.archived,
                trashed: p.trashed,
                albums: p.albums,
                editHistory: p.editHistory || [],
                thumbnail: p.thumbnail,
            }));
            await dbPut(STORE_META, { key: "photos_meta", value: metaPhotos });
            await dbPut(STORE_META, { key: "albums", value: state.albums });
        } catch (e) {
            console.warn("Save failed:", e);
        }
    }

    async function savePhotoData(photo) {
        // Save full photo data (with image src) separately per photo
        await dbPut(STORE_PHOTOS, { id: photo.id, src: photo.src });
    }

    async function loadPhotoSrc(id) {
        const data = await dbGet(STORE_PHOTOS, id);
        return data ? data.src : null;
    }

    async function load() {
        try {
            const metaResult = await dbGet(STORE_META, "photos_meta");
            const albumsResult = await dbGet(STORE_META, "albums");

            if (metaResult && metaResult.value) {
                state.photos = metaResult.value.map((p) => ({
                    ...p,
                    src: null, // Will be loaded on demand
                    _loaded: false,
                }));
            }
            if (albumsResult && albumsResult.value) {
                state.albums = albumsResult.value;
            }
        } catch (e) {
            console.warn("Load failed:", e);
        }
    }

    async function loadPhotoSrcIfNeeded(photo) {
        if (!photo._loaded && !photo.src) {
            photo.src = await loadPhotoSrc(photo.id);
            photo._loaded = true;
        }
        return photo.src;
    }

    // ─── UID ────────────────────────────────────────────────
    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // ─── Toast ──────────────────────────────────────────────
    function toast(message, iconName = "check_circle", duration = 3000, action = null) {
        const el = document.createElement("div");
        el.className = "toast";
        el.innerHTML = `
            <span class="material-icons-outlined">${iconName}</span>
            <span>${message}</span>
            ${action ? `<span class="toast-action">${action.label}</span>` : ""}
        `;
        DOM.toastContainer.appendChild(el);

        if (action) {
            el.querySelector(".toast-action").addEventListener("click", () => {
                action.fn();
                removeToast(el);
            });
        }
        setTimeout(() => removeToast(el), duration);
    }

    function removeToast(el) {
        if (!el.parentNode) return;
        el.classList.add("toast-out");
        el.addEventListener("animationend", () => el.remove());
    }

    // ─── Utilities ──────────────────────────────────────────
    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
        return (bytes / 1073741824).toFixed(2) + " GB";
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const photoDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const diff = (today - photoDay) / 86400000;

        if (diff === 0) return "Today";
        if (diff === 1) return "Yesterday";
        if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
        return d.toLocaleDateString("en-US", {
            month: "long", day: "numeric",
            year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
    }

    function formatDateFull(dateStr) {
        return new Date(dateStr).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit",
        });
    }

    function debounce(fn, delay) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    // Generate thumbnail from image (faster grid rendering)
    function generateThumbnail(src, maxSize = 300) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const ratio = Math.min(maxSize / img.width, maxSize / img.height);
                canvas.width = img.width * ratio;
                canvas.height = img.height * ratio;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.7));
            };
            img.onerror = () => resolve(src);
            img.src = src;
        });
    }

    // ─── View Switching ─────────────────────────────────────
    function switchView(viewName) {
        state.currentView = viewName;
        state.selected.clear();
        state.selectMode = false;
        updateSelectionUI();

        $$(".view").forEach((v) => v.classList.remove("active"));
        const target = $(`#view-${viewName}`);
        if (target) target.classList.add("active");

        $$(".nav-item").forEach((n) => {
            n.classList.toggle("active", n.dataset.view === viewName);
        });

        renderCurrentView();

        if (window.innerWidth <= 1024) {
            DOM.sidebar.classList.remove("sidebar-open");
        }
    }

    function renderCurrentView() {
        switch (state.currentView) {
            case "photos": renderPhotos(); break;
            case "favorites": renderFavorites(); break;
            case "albums": renderAlbums(); break;
            case "explore": renderExplore(); break;
            case "archive": renderArchive(); break;
            case "trash": renderTrash(); break;
        }
        updateStorage();
    }

    // ─── Photo Grid Rendering ───────────────────────────────
    function getVisiblePhotos() {
        let photos = state.photos.filter((p) => !p.trashed && !p.archived);

        if (state.searchQuery) {
            const q = state.searchQuery.toLowerCase();
            photos = photos.filter((p) => p.name.toLowerCase().includes(q));
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        if (state.filterChip === "today") {
            photos = photos.filter((p) => new Date(p.date) >= today);
        } else if (state.filterChip === "week") {
            const d = new Date(today); d.setDate(d.getDate() - 7);
            photos = photos.filter((p) => new Date(p.date) >= d);
        } else if (state.filterChip === "month") {
            const d = new Date(today); d.setMonth(d.getMonth() - 1);
            photos = photos.filter((p) => new Date(p.date) >= d);
        }

        return photos.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    function renderPhotos() {
        const photos = getVisiblePhotos();
        if (photos.length === 0) {
            DOM.emptyState.classList.remove("hidden");
            DOM.photoGrid.classList.add("hidden");
            return;
        }
        DOM.emptyState.classList.add("hidden");
        DOM.photoGrid.classList.remove("hidden");
        renderPhotoGrid(DOM.photoGrid, photos);
    }

    function renderPhotoGrid(container, photos) {
        container.innerHTML = "";
        container.className = `photo-grid${state.selectMode ? " select-mode" : ""}`;
        if (state.gridMode === "compact") container.classList.add("grid-compact");
        else if (state.gridMode === "large") container.classList.add("grid-large");

        // Group by date
        const groups = {};
        photos.forEach((p) => {
            const key = new Date(p.date).toLocaleDateString();
            if (!groups[key]) groups[key] = [];
            groups[key].push(p);
        });

        Object.entries(groups).forEach(([dateKey, groupPhotos]) => {
            const header = document.createElement("div");
            header.className = "date-header";
            header.innerHTML = `
                <div class="date-check"><span class="material-icons-outlined">check</span></div>
                <span>${formatDate(groupPhotos[0].date)}</span>
            `;
            container.appendChild(header);

            groupPhotos.forEach((photo, i) => {
                const el = document.createElement("div");
                el.className = `photo-item${state.selected.has(photo.id) ? " selected" : ""}`;
                el.dataset.id = photo.id;
                el.style.animationDelay = `${(i % 20) * 30}ms`;

                // Use thumbnail for grid (fast), full image only in lightbox
                const displaySrc = photo.thumbnail || photo.src || "";
                el.innerHTML = `
                    <img src="${displaySrc}" alt="${photo.name}" loading="lazy">
                    <div class="photo-overlay"></div>
                    <div class="photo-check${state.selected.has(photo.id) ? " checked" : ""}">
                        <span class="material-icons-outlined">check</span>
                    </div>
                    <div class="photo-favorite${photo.favorite ? " is-favorite" : ""}">
                        <span class="material-icons-outlined">${photo.favorite ? "favorite" : "favorite_border"}</span>
                    </div>
                `;

                el.querySelector(".photo-check").addEventListener("click", (e) => {
                    e.stopPropagation();
                    toggleSelect(photo.id);
                });

                el.querySelector(".photo-favorite").addEventListener("click", (e) => {
                    e.stopPropagation();
                    toggleFavorite(photo.id);
                });

                el.addEventListener("click", () => {
                    if (state.selectMode) {
                        toggleSelect(photo.id);
                    } else {
                        openLightbox(photos, photos.indexOf(photo));
                    }
                });

                container.appendChild(el);
            });
        });
    }

    function renderFavorites() {
        const photos = state.photos.filter((p) => p.favorite && !p.trashed && !p.archived);
        const grid = $("#favorites-grid");
        const empty = $("#favorites-empty");
        if (photos.length === 0) {
            empty.classList.remove("hidden"); grid.classList.add("hidden");
        } else {
            empty.classList.add("hidden"); grid.classList.remove("hidden");
            renderPhotoGrid(grid, photos);
        }
    }

    function renderArchive() {
        const photos = state.photos.filter((p) => p.archived && !p.trashed);
        const grid = $("#archive-grid");
        const empty = $("#archive-empty");
        if (photos.length === 0) {
            empty.classList.remove("hidden"); grid.classList.add("hidden");
        } else {
            empty.classList.add("hidden"); grid.classList.remove("hidden");
            renderPhotoGrid(grid, photos);
        }
    }

    function renderTrash() {
        const photos = state.photos.filter((p) => p.trashed);
        const grid = $("#trash-grid");
        const empty = $("#trash-empty");
        const emptyBtn = $("#btn-empty-trash");
        if (photos.length === 0) {
            empty.classList.remove("hidden"); grid.classList.add("hidden"); emptyBtn.classList.add("hidden");
        } else {
            empty.classList.add("hidden"); grid.classList.remove("hidden"); emptyBtn.classList.remove("hidden");
            renderPhotoGrid(grid, photos);
        }
    }

    function renderExplore() {
        const photos = state.photos.filter((p) => !p.trashed && !p.archived);
        const grid = $("#explore-grid");
        if (photos.length > 0) {
            renderPhotoGrid(grid, [...photos].sort(() => Math.random() - 0.5));
        }
    }

    // ─── Albums ─────────────────────────────────────────────
    function renderAlbums() {
        const grid = $("#albums-grid");
        const empty = $("#albums-empty");
        if (state.albums.length === 0) {
            empty.classList.remove("hidden"); grid.classList.add("hidden"); return;
        }
        empty.classList.add("hidden"); grid.classList.remove("hidden");
        grid.innerHTML = "";

        state.albums.forEach((album) => {
            const albumPhotos = state.photos.filter(
                (p) => p.albums && p.albums.includes(album.id) && !p.trashed
            );
            const card = document.createElement("div");
            card.className = "album-card";

            let coverHTML;
            if (albumPhotos.length >= 4) {
                coverHTML = albumPhotos.slice(0, 4).map((p) =>
                    `<img src="${p.thumbnail || p.src || ""}" alt="">`
                ).join("");
            } else if (albumPhotos.length > 0) {
                coverHTML = `<img src="${albumPhotos[0].thumbnail || albumPhotos[0].src || ""}" alt="" style="grid-column:1/-1;grid-row:1/-1;">`;
            } else {
                coverHTML = `<div class="album-placeholder"><span class="material-icons-outlined">photo_album</span></div>`;
            }

            card.innerHTML = `
                <div class="album-cover">${coverHTML}</div>
                <div class="album-info">
                    <div class="album-name">${album.name}</div>
                    <div class="album-count">${albumPhotos.length} item${albumPhotos.length !== 1 ? "s" : ""}</div>
                </div>
            `;
            card.addEventListener("click", () => openAlbumView(album));
            grid.appendChild(card);
        });
    }

    function openAlbumView(album) {
        const photos = state.photos.filter(
            (p) => p.albums && p.albums.includes(album.id) && !p.trashed
        );
        const view = $("#view-albums");
        const grid = $("#albums-grid");
        const empty = $("#albums-empty");
        const header = view.querySelector(".view-title");
        const originalTitle = header.textContent;
        header.textContent = album.name;

        const backBtn = document.createElement("button");
        backBtn.className = "icon-btn";
        backBtn.innerHTML = '<span class="material-icons-outlined">arrow_back</span>';
        backBtn.style.marginRight = "12px";
        header.parentElement.insertBefore(backBtn, header);

        empty.classList.add("hidden");
        grid.classList.remove("hidden");
        grid.innerHTML = "";

        if (photos.length > 0) {
            renderPhotoGrid(grid, photos);
        } else {
            grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
                <div class="empty-illustration"><span class="material-icons-outlined">add_photo_alternate</span></div>
                <h3>Album is empty</h3><p>Select photos and add them to this album</p>
            </div>`;
        }

        backBtn.addEventListener("click", () => {
            backBtn.remove();
            header.textContent = originalTitle;
            renderAlbums();
        });
    }

    function createAlbum(name) {
        const album = { id: uid(), name: name.trim(), created: new Date().toISOString() };
        state.albums.push(album);
        save();
        renderAlbums();
        toast(`Album "${album.name}" created`);
    }

    // ─── Photo Actions ──────────────────────────────────────
    function toggleFavorite(id) {
        const photo = state.photos.find((p) => p.id === id);
        if (!photo) return;
        photo.favorite = !photo.favorite;
        save();
        renderCurrentView();
        toast(photo.favorite ? "Added to favorites" : "Removed from favorites",
            photo.favorite ? "favorite" : "favorite_border");
    }

    function deletePhotos(ids) {
        ids.forEach((id) => {
            const photo = state.photos.find((p) => p.id === id);
            if (photo) photo.trashed = true;
        });
        save();
        state.selected.clear();
        state.selectMode = false;
        updateSelectionUI();
        renderCurrentView();
        toast(`${ids.length} photo${ids.length > 1 ? "s" : ""} moved to trash`, "delete_outline", 5000, {
            label: "Undo",
            fn: () => {
                ids.forEach((id) => {
                    const p = state.photos.find((x) => x.id === id);
                    if (p) p.trashed = false;
                });
                save();
                renderCurrentView();
            },
        });
    }

    function archivePhotos(ids) {
        ids.forEach((id) => {
            const p = state.photos.find((x) => x.id === id);
            if (p) p.archived = true;
        });
        save();
        state.selected.clear(); state.selectMode = false;
        updateSelectionUI();
        renderCurrentView();
        toast(`${ids.length} photo${ids.length > 1 ? "s" : ""} archived`, "archive");
    }

    function emptyTrash() {
        const trashed = state.photos.filter((p) => p.trashed);
        trashed.forEach((p) => dbDelete(STORE_PHOTOS, p.id));
        state.photos = state.photos.filter((p) => !p.trashed);
        save();
        renderCurrentView();
        toast(`${trashed.length} photos permanently deleted`, "delete_forever");
    }

    // ─── Rename Photo ───────────────────────────────────────
    function renamePhoto(id) {
        const photo = state.photos.find((p) => p.id === id);
        if (!photo) return;
        const newName = prompt("Rename photo:", photo.name);
        if (newName && newName.trim()) {
            photo.name = newName.trim();
            save();
            renderCurrentView();
            toast("Photo renamed", "edit");
        }
    }

    // ─── Selection ──────────────────────────────────────────
    function toggleSelect(id) {
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);

        state.selectMode = state.selected.size > 0;
        updateSelectionUI();
        renderCurrentView();
    }

    function updateSelectionUI() {
        if (state.selectMode && state.selected.size > 0) {
            DOM.selectionToolbar.classList.remove("hidden");
            DOM.selectionCount.textContent = `${state.selected.size} selected`;
        } else {
            DOM.selectionToolbar.classList.add("hidden");
        }
    }

    function deselectAll() {
        state.selected.clear();
        state.selectMode = false;
        updateSelectionUI();
        renderCurrentView();
    }

    // ─── Lightbox ───────────────────────────────────────────
    let lightboxPhotos = [];

    async function openLightbox(photos, index) {
        lightboxPhotos = photos;
        state.lightboxIndex = index;
        DOM.lightbox.classList.remove("hidden");
        document.body.style.overflow = "hidden";
        await updateLightbox();
    }

    function closeLightbox() {
        DOM.lightbox.classList.add("hidden");
        document.body.style.overflow = "";
        $("#lightbox-info-panel").classList.add("hidden");
    }

    async function updateLightbox() {
        const photo = lightboxPhotos[state.lightboxIndex];
        if (!photo) return;

        // Load full-res image
        const src = await loadPhotoSrcIfNeeded(photo);
        DOM.lightboxImg.src = src || photo.thumbnail || "";
        DOM.lightboxImg.alt = photo.name;
        DOM.lightboxDate.textContent = formatDateFull(photo.date);

        const favBtn = $("#lb-favorite");
        const icon = favBtn.querySelector(".material-icons-outlined");
        icon.textContent = photo.favorite ? "favorite" : "favorite_border";
        icon.style.color = photo.favorite ? "#ea4335" : "";

        $("#info-filename").textContent = photo.name;
        $("#info-date").textContent = formatDateFull(photo.date);
        $("#info-size").textContent = formatBytes(photo.size);
        $("#info-dimensions").textContent = `${photo.width} × ${photo.height}`;

        $(".lightbox-prev").style.visibility = state.lightboxIndex > 0 ? "visible" : "hidden";
        $(".lightbox-next").style.visibility = state.lightboxIndex < lightboxPhotos.length - 1 ? "visible" : "hidden";
    }

    async function lightboxPrev() {
        if (state.lightboxIndex > 0) { state.lightboxIndex--; await updateLightbox(); }
    }

    async function lightboxNext() {
        if (state.lightboxIndex < lightboxPhotos.length - 1) { state.lightboxIndex++; await updateLightbox(); }
    }

    // ─── Upload ─────────────────────────────────────────────
    function openUploadModal() {
        DOM.uploadModal.classList.remove("hidden");
        state.pendingUploads = [];
        DOM.uploadPreview.innerHTML = "";
        DOM.uploadPreview.classList.add("hidden");
        DOM.dropZone.classList.remove("hidden");
        DOM.btnConfirmUpload.disabled = true;
    }

    function closeUploadModal() {
        DOM.uploadModal.classList.add("hidden");
        state.pendingUploads = [];
    }

    function handleFiles(files) {
        const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
        if (imageFiles.length === 0) {
            toast("Please select image files", "warning"); return;
        }

        state.pendingUploads = [...state.pendingUploads, ...imageFiles];
        DOM.dropZone.classList.add("hidden");
        DOM.uploadPreview.classList.remove("hidden");
        DOM.btnConfirmUpload.disabled = false;

        imageFiles.forEach((file) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const thumb = document.createElement("div");
                thumb.className = "upload-thumb";
                thumb.innerHTML = `
                    <img src="${e.target.result}" alt="${file.name}">
                    <button class="remove-thumb">&times;</button>
                `;
                thumb.querySelector(".remove-thumb").addEventListener("click", () => {
                    state.pendingUploads = state.pendingUploads.filter((f) => f !== file);
                    thumb.remove();
                    if (state.pendingUploads.length === 0) {
                        DOM.dropZone.classList.remove("hidden");
                        DOM.uploadPreview.classList.add("hidden");
                        DOM.btnConfirmUpload.disabled = true;
                    }
                });
                DOM.uploadPreview.appendChild(thumb);
            };
            reader.readAsDataURL(file);
        });
    }

    async function confirmUpload() {
        const files = state.pendingUploads;
        const total = files.length;
        let processed = 0;

        DOM.btnConfirmUpload.disabled = true;
        DOM.btnConfirmUpload.innerHTML = `<span class="material-icons-outlined">hourglass_top</span> Uploading...`;

        for (const file of files) {
            const dataUrl = await readFileAsDataURL(file);
            const img = await loadImage(dataUrl);
            const thumbnail = await generateThumbnail(dataUrl);

            const photo = {
                id: uid(),
                src: dataUrl,
                thumbnail: thumbnail,
                name: file.name,
                size: file.size,
                width: img.naturalWidth,
                height: img.naturalHeight,
                date: new Date().toISOString(),
                favorite: false,
                archived: false,
                trashed: false,
                albums: [],
                editHistory: [],
                _loaded: true,
            };

            state.photos.push(photo);
            await savePhotoData(photo);

            processed++;
            DOM.btnConfirmUpload.innerHTML = `<span class="material-icons-outlined">hourglass_top</span> ${processed}/${total}`;
        }

        // Save metadata
        await save();

        DOM.btnConfirmUpload.innerHTML = `<span class="material-icons-outlined">cloud_upload</span> Upload`;
        closeUploadModal();
        switchView("photos");
        toast(`${total} photo${total > 1 ? "s" : ""} uploaded successfully!`, "cloud_done");
    }

    function readFileAsDataURL(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
    }

    function loadImage(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(img);
            img.src = src;
        });
    }

    // ─── Download ───────────────────────────────────────────
    async function downloadPhoto(photo) {
        const src = await loadPhotoSrcIfNeeded(photo);
        const a = document.createElement("a");
        a.href = src;
        a.download = photo.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast("Photo downloaded", "file_download");
    }

    async function downloadSelected() {
        for (const id of state.selected) {
            const p = state.photos.find((x) => x.id === id);
            if (p) await downloadPhoto(p);
        }
    }

    // ─── Photo Editor ───────────────────────────────────────
    let editCanvas, editCtx, editOriginalSrc;
    let editSettings = { brightness: 100, contrast: 100, saturate: 100, blur: 0, rotate: 0, hueRotate: 0, grayscale: 0, sepia: 0 };

    async function openEditor(photoId) {
        const photo = state.photos.find((p) => p.id === photoId);
        if (!photo) return;

        state.editingPhoto = photo;
        const src = await loadPhotoSrcIfNeeded(photo);
        editOriginalSrc = src;

        // Reset settings
        editSettings = { brightness: 100, contrast: 100, saturate: 100, blur: 0, rotate: 0, hueRotate: 0, grayscale: 0, sepia: 0 };

        DOM.editModal.classList.remove("hidden");

        // Load image into canvas
        const img = await loadImage(src);
        editCanvas = $("#edit-canvas");
        editCtx = editCanvas.getContext("2d");

        // Size canvas to fit while maintaining aspect ratio
        const maxW = Math.min(700, window.innerWidth - 80);
        const maxH = Math.min(500, window.innerHeight - 300);
        const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
        editCanvas.width = img.width * ratio;
        editCanvas.height = img.height * ratio;
        editCanvas.dataset.origW = img.width;
        editCanvas.dataset.origH = img.height;

        editCtx.drawImage(img, 0, 0, editCanvas.width, editCanvas.height);

        // Reset sliders
        $$(".edit-slider").forEach((slider) => {
            const prop = slider.dataset.prop;
            slider.value = editSettings[prop];
            const display = slider.parentElement.querySelector(".slider-value");
            if (display) display.textContent = slider.value;
        });

        $("#edit-photo-name").textContent = photo.name;
    }

    function applyEditorFilters() {
        const s = editSettings;
        const filterStr = `brightness(${s.brightness}%) contrast(${s.contrast}%) saturate(${s.saturate}%) blur(${s.blur}px) hue-rotate(${s.hueRotate}deg) grayscale(${s.grayscale}%) sepia(${s.sepia}%)`;

        editCanvas.style.filter = filterStr;
        editCanvas.style.transform = `rotate(${s.rotate}deg)`;
    }

    async function saveEditedPhoto() {
        if (!state.editingPhoto) return;

        const photo = state.editingPhoto;
        const img = await loadImage(editOriginalSrc);

        // Create final canvas at full resolution
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        if (editSettings.rotate === 90 || editSettings.rotate === 270) {
            canvas.width = img.height;
            canvas.height = img.width;
        } else {
            canvas.width = img.width;
            canvas.height = img.height;
        }

        // Apply rotation
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((editSettings.rotate * Math.PI) / 180);
        if (editSettings.rotate === 90 || editSettings.rotate === 270) {
            ctx.drawImage(img, -img.width / 2, -img.height / 2);
        } else {
            ctx.drawImage(img, -canvas.width / 2, -canvas.height / 2);
        }
        ctx.restore();

        // Apply CSS filters via a second canvas pass
        const s = editSettings;
        ctx.filter = `brightness(${s.brightness}%) contrast(${s.contrast}%) saturate(${s.saturate}%) blur(${s.blur}px) hue-rotate(${s.hueRotate}deg) grayscale(${s.grayscale}%) sepia(${s.sepia}%)`;
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext("2d");
        tempCtx.filter = ctx.filter;
        tempCtx.drawImage(canvas, 0, 0);

        const newSrc = tempCanvas.toDataURL("image/jpeg", 0.92);
        const newThumb = await generateThumbnail(newSrc);

        // Save edit history
        if (!photo.editHistory) photo.editHistory = [];
        photo.editHistory.push({
            date: new Date().toISOString(),
            settings: { ...editSettings },
        });

        // Update photo
        photo.src = newSrc;
        photo.thumbnail = newThumb;
        photo.size = Math.round(newSrc.length * 0.75); // Approximate size
        photo.width = tempCanvas.width;
        photo.height = tempCanvas.height;
        photo._loaded = true;

        await savePhotoData(photo);
        await save();

        DOM.editModal.classList.add("hidden");
        state.editingPhoto = null;

        renderCurrentView();
        toast("Photo saved!", "check_circle");
    }

    // ─── Storage ────────────────────────────────────────────
    function updateStorage() {
        const totalBytes = state.photos.reduce((sum, p) => sum + (p.size || 0), 0);
        const percent = Math.min((totalBytes / state.MAX_STORAGE) * 100, 100);
        DOM.storageFill.style.width = Math.max(percent, 0.1) + "%";
        DOM.storageText.textContent = `${formatBytes(totalBytes)} of 1 TB used`;
    }

    // ─── Search ─────────────────────────────────────────────
    function handleSearch() {
        state.searchQuery = DOM.searchInput.value.trim();
        DOM.searchClear.classList.toggle("hidden", !state.searchQuery);
        if (state.currentView !== "photos") switchView("photos");
        else renderPhotos();

        const title = $("#photos-title");
        title.textContent = state.searchQuery ? `Results for "${state.searchQuery}"` : "Photos";
    }

    // ─── Grid Toggle ────────────────────────────────────────
    function cycleGridMode() {
        const modes = ["default", "compact", "large"];
        const idx = modes.indexOf(state.gridMode);
        state.gridMode = modes[(idx + 1) % modes.length];
        const icons = { default: "grid_view", compact: "view_comfy", large: "view_agenda" };
        $("#btn-grid-toggle .material-icons-outlined").textContent = icons[state.gridMode];
        renderCurrentView();
    }

    // ─── Add to Album ───────────────────────────────────────
    function addSelectedToAlbum() {
        if (state.albums.length === 0) {
            toast("Create an album first", "info"); return;
        }
        const albumNames = state.albums.map((a) => a.name).join(", ");
        const name = prompt(`Choose album (${albumNames}):`);
        if (!name) return;
        const album = state.albums.find((a) => a.name.toLowerCase() === name.toLowerCase());
        if (!album) { toast("Album not found", "error"); return; }

        state.selected.forEach((id) => {
            const p = state.photos.find((x) => x.id === id);
            if (p) {
                if (!p.albums) p.albums = [];
                if (!p.albums.includes(album.id)) p.albums.push(album.id);
            }
        });
        save(); deselectAll();
        toast(`Added to "${album.name}"`, "library_add");
    }

    // ─── Context Menu (Right-Click) ─────────────────────────
    function showContextMenu(e, photo) {
        e.preventDefault();
        // Remove existing menu
        const old = $(".context-menu");
        if (old) old.remove();

        const menu = document.createElement("div");
        menu.className = "context-menu";
        menu.innerHTML = `
            <div class="ctx-item" data-action="edit"><span class="material-icons-outlined">edit</span> Edit photo</div>
            <div class="ctx-item" data-action="rename"><span class="material-icons-outlined">drive_file_rename_outline</span> Rename</div>
            <div class="ctx-item" data-action="favorite"><span class="material-icons-outlined">${photo.favorite ? 'favorite' : 'favorite_border'}</span> ${photo.favorite ? 'Unfavorite' : 'Favorite'}</div>
            <div class="ctx-item" data-action="download"><span class="material-icons-outlined">file_download</span> Download</div>
            <div class="ctx-item" data-action="info"><span class="material-icons-outlined">info</span> Details</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item" data-action="archive"><span class="material-icons-outlined">archive</span> Archive</div>
            <div class="ctx-item ctx-danger" data-action="delete"><span class="material-icons-outlined">delete_outline</span> Move to trash</div>
        `;

        // Position
        menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
        menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + "px";
        document.body.appendChild(menu);

        // Handle actions
        menu.querySelectorAll(".ctx-item").forEach((item) => {
            item.addEventListener("click", async () => {
                const action = item.dataset.action;
                switch (action) {
                    case "edit": openEditor(photo.id); break;
                    case "rename": renamePhoto(photo.id); break;
                    case "favorite": toggleFavorite(photo.id); break;
                    case "download": await downloadPhoto(photo); break;
                    case "info":
                        const photos = getVisiblePhotos();
                        await openLightbox(photos, photos.indexOf(photo));
                        $("#lightbox-info-panel").classList.remove("hidden");
                        break;
                    case "archive": archivePhotos([photo.id]); break;
                    case "delete": deletePhotos([photo.id]); break;
                }
                menu.remove();
            });
        });

        // Close on click outside
        setTimeout(() => {
            document.addEventListener("click", function closeCtx() {
                menu.remove();
                document.removeEventListener("click", closeCtx);
            }, { once: true });
        }, 50);
    }

    // ─── Event Bindings ─────────────────────────────────────
    function bindEvents() {
        // Sidebar toggle
        DOM.menuToggle.addEventListener("click", () => {
            if (window.innerWidth <= 1024) {
                DOM.sidebar.classList.toggle("sidebar-open");
            } else {
                DOM.sidebar.classList.toggle("sidebar-collapsed");
            }
        });

        // Navigation
        $$(".nav-item").forEach((item) => {
            item.addEventListener("click", (e) => {
                e.preventDefault();
                switchView(item.dataset.view);
            });
        });

        // Search
        DOM.searchInput.addEventListener("input", debounce(handleSearch, 300));
        DOM.searchClear.addEventListener("click", () => { DOM.searchInput.value = ""; handleSearch(); });

        // Filter chips
        $$(".chip-btn[data-filter]").forEach((chip) => {
            chip.addEventListener("click", () => {
                $$(".chip-btn[data-filter]").forEach((c) => c.classList.remove("active"));
                chip.classList.add("active");
                state.filterChip = chip.dataset.filter;
                renderPhotos();
            });
        });

        // Upload
        $("#btn-upload-header").addEventListener("click", openUploadModal);
        $("#btn-upload-empty").addEventListener("click", openUploadModal);
        DOM.dropZone.addEventListener("click", () => DOM.fileInput.click());
        DOM.fileInput.addEventListener("change", (e) => { handleFiles(e.target.files); DOM.fileInput.value = ""; });
        DOM.btnConfirmUpload.addEventListener("click", confirmUpload);
        $("#btn-cancel-upload").addEventListener("click", closeUploadModal);

        // Drag & Drop on drop zone
        DOM.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); DOM.dropZone.classList.add("drag-over"); });
        DOM.dropZone.addEventListener("dragleave", () => DOM.dropZone.classList.remove("drag-over"));
        DOM.dropZone.addEventListener("drop", (e) => { e.preventDefault(); DOM.dropZone.classList.remove("drag-over"); handleFiles(e.dataTransfer.files); });

        // Global drag & drop (auto-open upload modal)
        document.body.addEventListener("dragover", (e) => e.preventDefault());
        document.body.addEventListener("drop", (e) => {
            e.preventDefault();
            if (!DOM.uploadModal.classList.contains("hidden")) return;
            openUploadModal();
            setTimeout(() => handleFiles(e.dataTransfer.files), 100);
        });

        // Grid toggle
        $("#btn-grid-toggle").addEventListener("click", cycleGridMode);

        // Select mode
        $("#btn-select-mode").addEventListener("click", () => {
            state.selectMode = !state.selectMode;
            if (!state.selectMode) deselectAll();
            renderCurrentView();
        });

        // Album modal
        $("#btn-create-album").addEventListener("click", () => DOM.albumModal.classList.remove("hidden"));
        $("#btn-create-album-empty").addEventListener("click", () => DOM.albumModal.classList.remove("hidden"));
        DOM.albumNameInput.addEventListener("input", () => { DOM.btnConfirmAlbum.disabled = !DOM.albumNameInput.value.trim(); });
        DOM.btnConfirmAlbum.addEventListener("click", () => {
            createAlbum(DOM.albumNameInput.value);
            DOM.albumModal.classList.add("hidden");
            DOM.albumNameInput.value = "";
        });
        DOM.albumNameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && DOM.albumNameInput.value.trim()) {
                createAlbum(DOM.albumNameInput.value);
                DOM.albumModal.classList.add("hidden");
                DOM.albumNameInput.value = "";
            }
        });
        $("#btn-cancel-album").addEventListener("click", () => { DOM.albumModal.classList.add("hidden"); DOM.albumNameInput.value = ""; });

        // Modal close
        $$(".modal-close").forEach((btn) => {
            btn.addEventListener("click", () => btn.closest(".modal-overlay").classList.add("hidden"));
        });
        $$(".modal-overlay").forEach((overlay) => {
            overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
        });

        // Lightbox
        $(".lightbox-back").addEventListener("click", closeLightbox);
        $(".lightbox-prev").addEventListener("click", lightboxPrev);
        $(".lightbox-next").addEventListener("click", lightboxNext);

        $("#lb-favorite").addEventListener("click", () => {
            const p = lightboxPhotos[state.lightboxIndex];
            if (p) { toggleFavorite(p.id); updateLightbox(); }
        });

        $("#lb-info").addEventListener("click", () => $("#lightbox-info-panel").classList.toggle("hidden"));
        $("#close-info-panel").addEventListener("click", () => $("#lightbox-info-panel").classList.add("hidden"));

        $("#lb-download").addEventListener("click", () => {
            const p = lightboxPhotos[state.lightboxIndex];
            if (p) downloadPhoto(p);
        });

        $("#lb-delete").addEventListener("click", () => {
            const photo = lightboxPhotos[state.lightboxIndex];
            if (!photo) return;
            deletePhotos([photo.id]);
            lightboxPhotos = lightboxPhotos.filter((p) => p.id !== photo.id);
            if (state.lightboxIndex >= lightboxPhotos.length) state.lightboxIndex = lightboxPhotos.length - 1;
            if (lightboxPhotos.length === 0) closeLightbox();
            else updateLightbox();
        });

        // Lightbox edit button
        $("#lb-edit").addEventListener("click", () => {
            const p = lightboxPhotos[state.lightboxIndex];
            if (p) { closeLightbox(); openEditor(p.id); }
        });

        // Keyboard
        document.addEventListener("keydown", (e) => {
            if (!DOM.lightbox.classList.contains("hidden")) {
                if (e.key === "Escape") closeLightbox();
                if (e.key === "ArrowLeft") lightboxPrev();
                if (e.key === "ArrowRight") lightboxNext();
            }
            if (e.key === "Escape") {
                $$(".modal-overlay").forEach((m) => m.classList.add("hidden"));
                if (state.selectMode) deselectAll();
                const ctx = $(".context-menu");
                if (ctx) ctx.remove();
            }
        });

        // Selection toolbar
        $("#btn-deselect").addEventListener("click", deselectAll);
        $("#sel-favorite").addEventListener("click", () => { state.selected.forEach((id) => toggleFavorite(id)); deselectAll(); });
        $("#sel-album").addEventListener("click", addSelectedToAlbum);
        $("#sel-archive").addEventListener("click", () => archivePhotos([...state.selected]));
        $("#sel-download").addEventListener("click", downloadSelected);
        $("#sel-delete").addEventListener("click", () => deletePhotos([...state.selected]));

        // Empty trash
        $("#btn-empty-trash").addEventListener("click", () => {
            if (confirm("Permanently delete all items in trash?")) emptyTrash();
        });

        // Right-click context menu on photo items
        document.addEventListener("contextmenu", (e) => {
            const photoItem = e.target.closest(".photo-item");
            if (photoItem) {
                const id = photoItem.dataset.id;
                const photo = state.photos.find((p) => p.id === id);
                if (photo) showContextMenu(e, photo);
            }
        });

        // Editor sliders
        $$(".edit-slider").forEach((slider) => {
            slider.addEventListener("input", () => {
                const prop = slider.dataset.prop;
                editSettings[prop] = parseFloat(slider.value);
                const display = slider.parentElement.querySelector(".slider-value");
                if (display) display.textContent = slider.value;
                applyEditorFilters();
            });
        });

        // Editor buttons
        $("#btn-rotate-left").addEventListener("click", () => {
            editSettings.rotate = (editSettings.rotate - 90 + 360) % 360;
            applyEditorFilters();
        });
        $("#btn-rotate-right").addEventListener("click", () => {
            editSettings.rotate = (editSettings.rotate + 90) % 360;
            applyEditorFilters();
        });
        $("#btn-reset-edit").addEventListener("click", () => {
            editSettings = { brightness: 100, contrast: 100, saturate: 100, blur: 0, rotate: 0, hueRotate: 0, grayscale: 0, sepia: 0 };
            $$(".edit-slider").forEach((slider) => {
                const prop = slider.dataset.prop;
                slider.value = editSettings[prop];
                const display = slider.parentElement.querySelector(".slider-value");
                if (display) display.textContent = slider.value;
            });
            applyEditorFilters();
        });
        $("#btn-save-edit").addEventListener("click", saveEditedPhoto);
        $("#btn-cancel-edit").addEventListener("click", () => {
            DOM.editModal.classList.add("hidden");
            state.editingPhoto = null;
        });
    }

    // ─── Authentication System ──────────────────────────────
    const AUTH_STORAGE_KEY = "mycloud_users";
    const SESSION_KEY = "mycloud_session";

    function getUsers() {
        try {
            return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)) || [];
        } catch { return []; }
    }

    function saveUsers(users) {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(users));
    }

    function getSession() {
        try {
            return JSON.parse(sessionStorage.getItem(SESSION_KEY));
        } catch { return null; }
    }

    function setSession(user) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.userId, name: user.name }));
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    function showLoginError(msg) {
        const err = $("#login-error");
        const text = $("#login-error-text");
        text.textContent = msg;
        err.classList.remove("hidden");
        // Re-trigger shake animation
        err.style.animation = "none";
        err.offsetHeight; // reflow
        err.style.animation = "";
    }

    function showSignupError(msg) {
        const err = $("#signup-error");
        const text = $("#signup-error-text");
        text.textContent = msg;
        err.classList.remove("hidden");
        err.style.animation = "none";
        err.offsetHeight;
        err.style.animation = "";
    }

    function hideErrors() {
        $("#login-error").classList.add("hidden");
        $("#signup-error").classList.add("hidden");
        // Remove any success messages
        const success = document.querySelector(".login-success");
        if (success) success.remove();
    }

    function switchToSignup() {
        hideErrors();
        $("#login-form").classList.remove("active");
        $("#signup-form").classList.add("active");
        $("#signup-name").focus();
    }

    function switchToLogin() {
        hideErrors();
        $("#signup-form").classList.remove("active");
        $("#login-form").classList.add("active");
        $("#login-userid").focus();
    }

    function handleLogin(e) {
        e.preventDefault();
        hideErrors();

        const userId = $("#login-userid").value.trim();
        const password = $("#login-password").value;

        if (!userId || !password) {
            showLoginError("Please fill in all fields");
            return;
        }

        const users = getUsers();
        const user = users.find(u => u.userId === userId && u.password === password);

        if (!user) {
            showLoginError("Invalid User ID or password");
            $("#login-password").value = "";
            return;
        }

        // Successful login
        setSession(user);
        loginSuccess(user);
    }

    function handleSignup(e) {
        e.preventDefault();
        hideErrors();

        const name = $("#signup-name").value.trim();
        const userId = $("#signup-userid").value.trim();
        const password = $("#signup-password").value;
        const confirm = $("#signup-confirm").value;

        if (!name || !userId || !password || !confirm) {
            showSignupError("Please fill in all fields");
            return;
        }

        if (userId.length < 3) {
            showSignupError("User ID must be at least 3 characters");
            return;
        }

        if (password.length < 6) {
            showSignupError("Password must be at least 6 characters");
            return;
        }

        if (password !== confirm) {
            showSignupError("Passwords do not match");
            $("#signup-confirm").value = "";
            return;
        }

        const users = getUsers();
        if (users.find(u => u.userId === userId)) {
            showSignupError("This User ID is already taken");
            return;
        }

        // Create new account
        const newUser = { userId, name, password, createdAt: new Date().toISOString() };
        users.push(newUser);
        saveUsers(users);

        // Switch to login with success message
        switchToLogin();
        const form = $("#login-form");
        const successEl = document.createElement("div");
        successEl.className = "login-success";
        successEl.innerHTML = `
            <span class="material-icons-outlined">check_circle</span>
            <span>Account created! Sign in with your new credentials.</span>
        `;
        form.insertBefore(successEl, form.firstChild);
        $("#login-userid").value = userId;
        $("#login-password").focus();

        // Clear signup form
        $("#signup-name").value = "";
        $("#signup-userid").value = "";
        $("#signup-password").value = "";
        $("#signup-confirm").value = "";
    }

    function togglePasswordVisibility(inputId, btnId) {
        const input = $(`#${inputId}`);
        const icon = $(`#${btnId} .material-icons-outlined`);
        if (input.type === "password") {
            input.type = "text";
            icon.textContent = "visibility";
        } else {
            input.type = "password";
            icon.textContent = "visibility_off";
        }
    }

    function loginSuccess(user) {
        const loginScreen = $("#login-screen");
        loginScreen.classList.add("login-exit");

        // Update avatar with user initial
        const avatar = $("#user-avatar");
        avatar.querySelector("span").textContent = user.name.charAt(0).toUpperCase();
        avatar.title = `${user.name} (${user.userId})`;

        setTimeout(() => {
            loginScreen.classList.add("hidden");
            loginScreen.classList.remove("login-exit");
            renderCurrentView();
            updateStorage();
        }, 600);
    }

    function logout() {
        clearSession();
        const loginScreen = $("#login-screen");
        loginScreen.classList.remove("hidden");
        // Clear login form
        $("#login-userid").value = "";
        $("#login-password").value = "";
        hideErrors();
        switchToLogin();
    }

    function bindAuthEvents() {
        // Form submissions
        $("#login-form").addEventListener("submit", handleLogin);
        $("#signup-form").addEventListener("submit", handleSignup);

        // Toggle between login/signup
        $("#show-signup").addEventListener("click", switchToSignup);
        $("#show-login").addEventListener("click", switchToLogin);

        // Password visibility toggles
        $("#toggle-password").addEventListener("click", () => {
            togglePasswordVisibility("login-password", "toggle-password");
        });
        $("#toggle-signup-password").addEventListener("click", () => {
            togglePasswordVisibility("signup-password", "toggle-signup-password");
        });

        // User avatar click -> logout
        $("#user-avatar").addEventListener("click", () => {
            if (confirm("Sign out of MyCloud?")) {
                logout();
            }
        });
    }

    // ─── Init ───────────────────────────────────────────────
    async function init() {
        cacheDom();
        bindAuthEvents();

        // DB may fail on file:// URLs — don't block auth
        try {
            await openDB();
            await load();
        } catch (e) {
            console.warn("IndexedDB unavailable (file:// URL?):", e);
        }

        bindEvents();

        // Check for existing session
        const session = getSession();
        if (session) {
            loginSuccess(session);
            renderCurrentView();
        } else {
            // Show login screen — don't render app until logged in
            $("#login-screen").classList.remove("hidden");
        }

        setTimeout(() => updateStorage(), 300);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
