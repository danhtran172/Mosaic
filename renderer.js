const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let store, allAssets = [], currentView = 'all', currentFilter = 'all', selectedId = null, selectedIds = new Set(), searchTerm = '', hoverTimer = null, hoverTargetId = null, dragId = null, dragGroupId = null, autoScrollFrame = null, autoScrollVelocity = 0, masonryFrame = null, justifiedObserver = null, tagManagerKind = 'theme', tagManagerGalleryId = null, copiedTagGroup = null, copiedGalleryTagGroup = null, exportedExclusiveTagGroups = [], lightboxAssets = [], lightboxIndex = -1, sourceRefreshTimer = null, sourceRefreshInProgress = false, sourceTrackingTimer = null, sourceTrackingInProgress = false, canvasRenderLimit = 50, canvasBatchQueued = false, canvasResultKey = '', assetViewCache = null, assetRevision = 0, ungroupedDuringDrag = false, discardOriginGalleryId = null, lockedGalleryId = null, advancedFilter = { tags: [], galleryIds: [], sourceIds: [] }, selectedGalleryIds = new Set(), galleryDragId = null, galleryGroupTimer = null, currentProfileInfo = null;
const unlockedGalleryIds = new Set();
const pendingSourcePaths = new Set();
const thumbnailMemory = new Map();
const thumbnailQueued = new Set();
const thumbnailFailed = new Set();
const thumbnailQueue = [];
const CANVAS_BATCH_SIZE = 50;
const THUMBNAIL_BATCH_SIZE = 50;
const MAX_GRID_MEDIA_HEIGHT = 182;
const GALLERY_EXCLUDE_RECOVERY_VERSION = 1;
let thumbnailQueueRunning = false, thumbnailQueueScheduled = false, lastCanvasScrollTop = 0, canvasScrollDirection = 'down', videoSpeedFeedbackTimer = null;
const colors = ['#a78bfa','#f6a86f','#65c7c7','#e9cd63','#e98daa','#83b96b'];
const languages={vi:{allMedia:'Main Gallery',images:'Hình ảnh',videos:'Video',untagged:'Chưa gắn tag',manageTags:'Quản lý tag',language:'Ngôn ngữ',security:'Bảo mật ứng dụng',lock:'Khóa ứng dụng',addFolder:'Thêm thư mục',emptyTitle:'Không gian hình ảnh của bạn',emptyText:'Thêm một thư mục để bắt đầu sắp xếp ảnh và video theo cách của riêng bạn.',emptyAdd:'Thêm thư mục đầu tiên',search:'Tìm kiếm ảnh, tag, nhân vật...',library:'THƯ VIỆN',privateFolder:'GALLERY',source:'NGUỒN ẢNH'},en:{allMedia:'Main Gallery',images:'Images',videos:'Videos',untagged:'Untagged',manageTags:'Manage tags',language:'Language',security:'App security',lock:'Lock app',addFolder:'Add folder',emptyTitle:'Your visual space',emptyText:'Add a folder to start organizing your images and videos your way.',emptyAdd:'Add your first folder',search:'Search media, tags, characters...',library:'LIBRARY',privateFolder:'GALLERY',source:'MEDIA SOURCE'}};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const escapeHTML = value => String(value || '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[char]));
const fileURL = p => `file:///${encodeURI(p.replace(/\\/g, '/'))}`;
const mediaURL = asset => asset?.contentUrl || fileURL(asset.path);
const thumbnailKey = asset => `${asset?.id}:${asset?.modified || 0}`;
const gridMediaURL = asset => thumbnailMemory.get(thumbnailKey(asset)) || '';
const thumbnailImageHTML = (asset, className = '') => {
  const url = gridMediaURL(asset);
  return url ? `<img${className ? ` class="${className}"` : ''} src="${url}" loading="lazy" alt="${escapeHTML(asset?.name || '')}">` : '';
};
const meta = id => (store.assetMeta[id] ||= { tags: [], persons: [], tagGroups: {}, note: '', favorite: false, order: Date.now() });
function ensureTagGroups() {
  const builtIns=[{id:'theme',name:'Theme',legacyField:'tags'},{id:'character',name:'Character',legacyField:'persons'}];
  store.tagGroups ||= builtIns;
  builtIns.forEach(group=>{if(!store.tagGroups.some(item=>item.id===group.id))store.tagGroups.unshift(group);});
  store.tagGroups.forEach(group=>{group.name ||= group.id; if(!group.legacyField)group.values ||= [];});
}
const tagGroups = () => (ensureTagGroups(), store.tagGroups);
const tagGroupDefinitions = group => group.legacyField==='tags'?store.tagDefinitions:group.legacyField==='persons'?store.personDefinitions:(group.values ||= []);
function tagGroupValues(item, group) { if(group.legacyField)return (item[group.legacyField] ||= []); item.tagGroups ||= {}; return (item.tagGroups[group.id] ||= []); }
function replaceTagGroupValue(group, oldName, newName) { Object.values(store.assetMeta).forEach(item=>{const values=tagGroupValues(item,group);const next=values.map(value=>value===oldName?newName:value).filter(Boolean);if(group.legacyField)item[group.legacyField]=next;else item.tagGroups[group.id]=next;});if(group.legacyField==='tags')store.collections.forEach(collection=>collection.defaultTags=collection.defaultTags.map(tag=>tag===oldName?newName:tag).filter(Boolean));if(group.legacyField==='persons')store.collections.forEach(collection=>collection.defaultPersons=collection.defaultPersons.map(tag=>tag===oldName?newName:tag).filter(Boolean));}
function managedTagGroups(collection) { const enabled=new Set(collection?.generalTagGroupIds||tagGroups().map(group=>group.id)),general=tagGroups().filter(group=>enabled.has(group.id)),exclusive=(collection?.exclusiveTagGroups||[]).filter(group=>group.enabled!==false);return [...general,...exclusive]; }
function galleryAutoTagValues(collection, group) { if(group.legacyField==='tags')return (collection.defaultTags ||= []);if(group.legacyField==='persons')return (collection.defaultPersons ||= []);collection.autoTagGroups ||= {};return (collection.autoTagGroups[group.id] ||= []); }
function applyGalleryAutoTags(collection, assetId) { managedTagGroups(collection).forEach(group=>{const target=tagGroupValues(meta(assetId),group);galleryAutoTagValues(collection,group).forEach(value=>{if(!target.includes(value))target.push(value);});}); }
function normalizeGalleryModels() { const galleryIds=new Set(store.collections.map(collection=>collection.id));store.collections.forEach((collection,index)=>{collection.order ??= Date.now()-index;collection.generalTagGroupIds ||= tagGroups().map(group=>group.id);collection.exclusiveTagGroups ||= [];collection.autoTagGroups ||= {};});store.galleryGroups=(store.galleryGroups||[]).map((group,index)=>({...group,title:group.title||'Gallery group',order:group.order??Date.now()-index,galleries:[...new Set((group.galleries||[]).filter(id=>galleryIds.has(id)))]})).filter(group=>group.galleries.length>1); }
const currentCollection = () => currentView.startsWith('collection:') ? store.collections.find(c => c.id === currentView.slice(11)) : null;
const currentSource = () => currentView.startsWith('source:') ? store.sources.find(s => s.id === currentView.slice(7)) : null;
const activeGroups = () => currentCollection()?.groups || store.libraryGroups;
const t = key => languages[store?.language || 'vi'][key] || key;
const selectedTargetIds = () => selectedIds.size ? [...selectedIds] : selectedId ? [selectedId] : [];
function isDirectAllMediaSource(asset) { const source=store.sources.find(item=>item.id===asset?.sourceId);return !!source&&(source.id==='allsight-web-imports'||/^(web extention|web imports?)$/i.test(source.name||'')||(store.librarySourceIds||[]).includes(source.id)); }
function isGalleryAvailable(gallery) { return !!gallery&&(!gallery.locked||unlockedGalleryIds.has(gallery.id)); }
function galleryProvidesAsset(gallery, asset) { return !!asset&&isGalleryAvailable(gallery)&&!(gallery.discardedIds||[]).includes(asset.id)&&((gallery.items||[]).includes(asset.id)||((gallery.sourceIds||[]).includes(asset.sourceId)&&!meta(asset.id).isDuplicate)); }
function unlockedGalleryAssetIds() { const ids=new Set();allAssets.forEach(asset=>{if(isDirectAllMediaSource(asset)||store.collections.some(gallery=>galleryProvidesAsset(gallery,asset)))ids.add(asset.id);});return ids; }
function isExcludedFromAllMedia(asset) { const excludedIds=new Set(store.allMediaExcludedGalleryIds||[]);if(!excludedIds.size||isDirectAllMediaSource(asset))return false;const providers=store.collections.filter(gallery=>galleryProvidesAsset(gallery,asset));return providers.length>0&&providers.every(gallery=>excludedIds.has(gallery.id)); }
function excludedMainGalleryAssetCount(excludedGalleryIds=store.allMediaExcludedGalleryIds||[]) { const excludedIds=new Set(excludedGalleryIds);if(!excludedIds.size)return 0;return allAssets.filter(asset=>{if(isDirectAllMediaSource(asset))return false;const providers=store.collections.filter(gallery=>galleryProvidesAsset(gallery,asset));return providers.length>0&&providers.every(gallery=>excludedIds.has(gallery.id));}).length; }
function mainGalleryAssetCount() { return unlockedGalleryAssetIds().size-excludedMainGalleryAssetCount(); }
function allTags() { return [...new Set(Object.values(store.assetMeta).flatMap(m => m.tags || []).concat(store.tagDefinitions?.map(t => t.name) || []))]; }
function tagDefinition(name) { return store.tagDefinitions.find(tag => tag.name === name) || { name, color:'#687384' }; }
function save() { assetViewCache = null; assetRevision++; return window.vision.writeStore(store); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.remove('hidden'); clearTimeout(node.timer); node.timer = setTimeout(() => node.classList.add('hidden'), 2400); }
function sourceFolderName(folder) { return String(folder || '').replace(/[\\/]+$/, '').split(/\\|\//).pop() || 'Untitled source'; }
function sameSourceFolder(a, b) { return String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase(); }
function relativeAssetPath(asset, sourcePath) {
  if (asset.relativePath) return String(asset.relativePath).replace(/\\/g, '/');
  const prefix = String(sourcePath || '').replace(/[\\/]+$/, '').toLowerCase();
  const assetPath = String(asset.path || '');
  if ((prefix && assetPath.toLowerCase().startsWith(`${prefix}\\`)) || assetPath.toLowerCase().startsWith(`${prefix}/`)) return assetPath.slice(prefix.length + 1).replace(/\\/g, '/');
  return String(asset.name || '').replace(/\\/g, '/');
}
function remapScannedAssets(source, previousPath, assets) {
  const previousByRelative = new Map((source.assets || []).map(asset => [relativeAssetPath(asset, previousPath), asset]));
  assets.forEach(asset => {
    const previous = previousByRelative.get(relativeAssetPath(asset, previousPath));
    if (previous && previous.id !== asset.id) remapAssetId(previous.id, asset.id);
  });
}
function applySourceLocation(source, result) {
  const previousPath = source.path;
  if (result.folder) {
    source.path = result.folder;
    source.name = sourceFolderName(result.folder);
  }
  if (result.tracking) source.tracking = result.tracking;
  if (result.vaultBridgeId) source.vaultBridgeId = result.vaultBridgeId;
  return !sameSourceFolder(previousPath, source.path);
}
async function scanSource(source) {
  const result = await window.vision.scanFolder(source);
  const previousPath = source.path;
  const moved = applySourceLocation(source, result);
  remapScannedAssets(source, previousPath, result.assets || []);
  source.assets = result.assets || [];
  delete source.indexing;
  return moved;
}
async function restoreCachedSource(source) {
  const cached = await window.vision.cachedSource(source);
  if (!cached?.assets) return false;
  const previousPath = source.path;
  if (cached.tracking) source.tracking = cached.tracking;
  if (cached.vaultBridgeId) source.vaultBridgeId = cached.vaultBridgeId;
  remapScannedAssets(source, previousPath, cached.assets);
  source.assets = cached.assets;
  return true;
}
async function refreshSourcesInBackground(sourceIds) {
  if (sourceRefreshInProgress) return;
  sourceRefreshInProgress = true;
  try {
    const targets = store.sources.filter(source => !sourceIds || sourceIds.includes(source.id));
    for (const source of targets) {
      await scanSource(source);
      if (!store.sources.includes(source)) await window.vision.removeCachedSource(source.id);
    }
    await collectAssets();
    syncGallerySourceAssets();
    await save();
    render();
  } catch { /* The last consistent catalog remains available while a source is offline. */ }
  finally { sourceRefreshInProgress = false; }
}
async function trackRenamedSources() {
  if (!store || sourceTrackingInProgress || sourceRefreshInProgress) return;
  sourceTrackingInProgress = true;
  try {
    const changedIds = [];
    await Promise.all(store.sources.map(async source => {
      const result = await window.vision.resolveSource(source);
      if (result?.folder && !sameSourceFolder(source.path, result.folder)) {
        applySourceLocation(source, result);
        changedIds.push(source.id);
      }
    }));
    if (changedIds.length) {
      await syncSourceWatchers();
      await refreshSources(changedIds);
    }
  } finally { sourceTrackingInProgress = false; }
}
function startSourceTracking() {
  clearInterval(sourceTrackingTimer);
  sourceTrackingTimer = setInterval(trackRenamedSources, 3000);
}

async function restoreVaultBridgeSources() {
  let bridges;
  try { bridges = await window.vision.listVaultBridges(); } catch { return false; }
  let changed = false;
  for (const bridge of Array.isArray(bridges) ? bridges : []) {
    const folder = String(bridge?.folder || '').trim();
    const bridgeId = String(bridge?.id || '').trim();
    if (!folder || !bridgeId) continue;
    const existing = store.sources.find(source => source.vaultBridgeId === bridgeId) || store.sources.find(source => sameSourceFolder(source.path, folder));
    if (existing) {
      if (existing.vaultBridgeId !== bridgeId || !sameSourceFolder(existing.path, folder)) {
        existing.vaultBridgeId = bridgeId;
        existing.path = folder;
        existing.name = sourceFolderName(folder);
        changed = true;
      }
      if (bridge.tracking && JSON.stringify(existing.tracking) !== JSON.stringify(bridge.tracking)) { existing.tracking = bridge.tracking; changed = true; }
      continue;
    }
    const source = { id: uid(), path: folder, name: sourceFolderName(folder), assets: [], vaultBridgeId: bridgeId, tracking: bridge.tracking || undefined };
    store.sources.push(source);
    if (!store.librarySourceIds.includes(source.id)) store.librarySourceIds.push(source.id);
    changed = true;
  }
  return changed;
}
function recoverExcludedGalleryMedia() {
  if ((store.galleryExcludeRecoveryVersion || 0) >= GALLERY_EXCLUDE_RECOVERY_VERSION) return false;
  let changed=false;
  store.collections.forEach(gallery=>{
    const excluded=gallery.excludedItemIds||[];
    if (!excluded.length) return;
    gallery.items=[...new Set([...(gallery.items||[]),...excluded])];
    gallery.excludedItemIds=[];
    changed=true;
  });
  store.galleryExcludeRecoveryVersion=GALLERY_EXCLUDE_RECOVERY_VERSION;
  return changed;
}

async function init() {
  currentProfileInfo = await window.vision.currentProfile();
  store = await window.vision.readStore();
  store.sources ||= []; store.librarySourceIds ||= []; store.collections ||= []; store.discardedGalleries ||= []; store.assetMeta ||= {}; store.tagDefinitions ||= []; store.personDefinitions ||= []; store.libraryGroups ||= []; store.allMediaExcludedGalleryIds ||= []; store.allMediaExcludedGalleryIds=store.allMediaExcludedGalleryIds.filter(id=>store.collections.some(collection=>collection.id===id)); ensureTagGroups(); normalizeGalleryModels(); store.collections.forEach(collection=>{collection.defaultTags ||= [];collection.defaultPersons ||= [];collection.sourceIds ||= [];collection.manualItemIds ||= [];collection.discardedIds ||= [];collection.excludedItemIds ||= [];});Object.entries(store.assetMeta).forEach(([id,item])=>{item.tagGroups ||= {};if(item.hidden){store.collections.filter(gallery=>gallery.items.includes(id)).forEach(gallery=>{if(!gallery.discardedIds.includes(id))gallery.discardedIds.push(id);});delete item.hidden;}}); store.language ||= 'vi'; store.sourcesCollapsed ||= false; store.zoom ||= 155; applyLanguage(); applyZoom();
  const recoveredExcludedGalleryMedia=recoverExcludedGalleryMedia(),restoredVaultSources = await restoreVaultBridgeSources();
  // Restore the persistent catalog first so startup never waits for a full
  // filesystem walk. A background refresh reconciles it immediately after UI.
  await Promise.allSettled(store.sources.map(async source => {
    await restoreCachedSource(source);
  }));
  await collectAssets();
  const recoveredSourceLinks=inferLegacyGallerySources();
  syncGallerySourceAssets();
  if(recoveredSourceLinks || restoredVaultSources || recoveredExcludedGalleryMedia)await save();
  await syncSourceWatchers();
  startSourceTracking();
  bindEvents();
  render();
  if(recoveredExcludedGalleryMedia)toast('Đã khôi phục media từng bị exclude khỏi Gallery');
  setTimeout(() => refreshSourcesInBackground(), 750);
}
async function syncSourceWatchers() { await window.vision.watchSources(store.sources.map(source => source.path)); }
async function reloadImportedMedia() {
  const selected = selectedId;
  store = await window.vision.readStore();
  store.sources ||= []; store.librarySourceIds ||= []; store.collections ||= []; store.discardedGalleries ||= []; store.assetMeta ||= {}; store.tagDefinitions ||= []; store.personDefinitions ||= []; store.libraryGroups ||= []; store.allMediaExcludedGalleryIds ||= []; store.allMediaExcludedGalleryIds=store.allMediaExcludedGalleryIds.filter(id=>store.collections.some(collection=>collection.id===id)); ensureTagGroups(); normalizeGalleryModels(); store.collections.forEach(collection=>{collection.defaultTags ||= [];collection.defaultPersons ||= [];collection.sourceIds ||= [];collection.manualItemIds ||= [];collection.discardedIds ||= [];collection.excludedItemIds ||= [];});
  await collectAssets();
  const recoveredSourceLinks=inferLegacyGallerySources();
  syncGallerySourceAssets();
  if(recoveredSourceLinks)await save();
  await syncSourceWatchers();
  if (selected && allAssets.some(asset => asset.id === selected)) selectedId = selected;
  render();
  toast('Image Saved!');
}
function scheduleSourceRefresh(folder) {
  if (!store.sources.some(source => source.path === folder)) return;
  pendingSourcePaths.add(folder);
  clearTimeout(sourceRefreshTimer);
  sourceRefreshTimer = setTimeout(flushSourceRefresh, 650);
}
async function flushSourceRefresh() {
  if (sourceRefreshInProgress) return;
  const paths = [...pendingSourcePaths];
  pendingSourcePaths.clear();
  if (!paths.length) return;
  sourceRefreshInProgress = true;
  try {
    for (const source of store.sources.filter(source => paths.includes(source.path))) await scanSource(source);
    await collectAssets();
    syncGallerySourceAssets();
    const availableIds = new Set(allAssets.map(asset => asset.id));
    store.collections.forEach(collection => {
      collection.items = collection.items.filter(id => availableIds.has(id));
      (collection.groups || []).forEach(group => group.assets = group.assets.filter(id => availableIds.has(id)));
      collection.groups = (collection.groups || []).filter(group => group.assets.length > 1);
    });
    store.libraryGroups = (store.libraryGroups || []).map(group => ({ ...group, assets: group.assets.filter(id => availableIds.has(id)) })).filter(group => group.assets.length > 1);
    selectedIds = new Set([...selectedIds].filter(id => availableIds.has(id)));
    if (selectedId && !availableIds.has(selectedId)) selectedId = [...selectedIds][0] || null;
    await save();
    render();
    toast('Đã tự động cập nhật media');
  } finally {
    sourceRefreshInProgress = false;
    if (pendingSourcePaths.size) {
      clearTimeout(sourceRefreshTimer);
      sourceRefreshTimer = setTimeout(flushSourceRefresh, 650);
    }
  }
}
async function collectAssets() {
  const seen=new Set();
  // Source/catalog records are metadata only. Thumbnail URLs belong to the
  // transient memory cache and image bytes never enter the renderer store.
  store.sources.forEach(source => (source.assets || []).forEach(asset => delete asset.thumbnailUrl));
  allAssets=[...store.sources].sort((a,b)=>(b.path||'').length-(a.path||'').length).flatMap(source=>(source.assets||[]).map(asset=>({...asset,sourceId:source.id}))).filter(asset=>!seen.has(asset.id)&&seen.add(asset.id));
  allAssets.forEach(asset => meta(asset.id));
  assetViewCache = null;
  assetRevision++;
}
function inferLegacyGallerySources() {
  let changed=false;
  store.collections.forEach(gallery=>{
    gallery.sourceIds ||= [];gallery.manualItemIds ||= [];
    const itemIds=new Set(gallery.items||[]);
    store.sources.forEach(source=>{
      const sourceIds=(source.assets||[]).map(asset=>asset.id);
      if(sourceIds.length&&sourceIds.every(id=>itemIds.has(id))&&!gallery.sourceIds.includes(source.id)){
        gallery.sourceIds.push(source.id);changed=true;
      }
    });
  });
  return changed;
}
function syncGallerySourceAssets() {
  const availableIds=new Set(allAssets.map(asset=>asset.id));
  store.collections.forEach(gallery=>{
    gallery.sourceIds ||= []; gallery.manualItemIds ||= []; gallery.excludedItemIds ||= [];
    gallery.excludedItemIds=gallery.excludedItemIds.filter(id=>availableIds.has(id));
    const excludedIds=new Set(gallery.excludedItemIds), linkedSourceIds=new Set(allAssets.filter(asset=>gallery.sourceIds.includes(asset.sourceId)&&!meta(asset.id).isDuplicate).map(asset=>asset.id));
    const sourceAssetIds=[...linkedSourceIds].filter(id=>!excludedIds.has(id));
    sourceAssetIds.forEach(id=>applyGalleryAutoTags(gallery,id));
    const retained=(gallery.items||[]).filter(id=>availableIds.has(id)&&!excludedIds.has(id)&&(!linkedSourceIds.has(id)||gallery.manualItemIds.includes(id)));
    gallery.items=[...new Set([...retained,...sourceAssetIds])];
    (gallery.groups||[]).forEach(group=>group.assets=group.assets.filter(id=>gallery.items.includes(id)));
    gallery.groups=(gallery.groups||[]).filter(group=>group.assets.length>1);
  });
}
function visibleAssets() {
  const cacheKey = `${currentView}|${currentFilter}|${searchTerm}|${[...unlockedGalleryIds].sort().join(',')}|${(store.allMediaExcludedGalleryIds||[]).slice().sort().join(',')}|${JSON.stringify(advancedFilter)}`;
  if (assetViewCache?.key === cacheKey) return assetViewCache.assets;
  let output = [...allAssets]; const collection = currentCollection(), source = currentSource();
  const galleryIds=unlockedGalleryAssetIds();
  output = output.filter(asset=>collection ? collection.items.includes(asset.id)&&!(collection.discardedIds||[]).includes(asset.id) : galleryIds.has(asset.id));
  if(currentView==='all')output=output.filter(asset=>!isExcludedFromAllMedia(asset));
  if (source) output = output.filter(asset => asset.sourceId === source.id);
  if (currentView === 'images') output = output.filter(asset => asset.type === 'image');
  if (currentView === 'videos') output = output.filter(asset => asset.type === 'video');
  if (currentView === 'untagged') output = output.filter(asset => !meta(asset.id).tags.length && !meta(asset.id).persons.length);
  if (currentFilter === 'favorites') output = output.filter(asset => meta(asset.id).favorite);
  if (currentFilter === 'images') output = output.filter(asset => asset.type === 'image');
  if (currentFilter === 'videos') output = output.filter(asset => asset.type === 'video');
  const collectionGroups = collection?.groups || [];
  if (currentFilter === 'grouped') output = output.filter(asset => collectionGroups.some(group => group.assets.includes(asset.id)));
  if(advancedFilter.galleryIds.length)output=output.filter(asset=>advancedFilter.galleryIds.some(id=>galleryProvidesAsset(store.collections.find(gallery=>gallery.id===id),asset)));
  if(advancedFilter.sourceIds.length)output=output.filter(asset=>advancedFilter.sourceIds.includes(asset.sourceId));
  if(advancedFilter.tags.length)output=output.filter(asset=>advancedFilter.tags.some(key=>{const [groupId,...parts]=key.split('::'),group=tagGroups().find(item=>item.id===groupId);return group&&tagGroupValues(meta(asset.id),group).includes(parts.join('::'));}));
  const needle = searchTerm.trim().toLowerCase();
  if (needle) output = output.filter(asset => [asset.name, ...tagGroups().flatMap(group=>tagGroupValues(meta(asset.id),group))].join(' ').toLowerCase().includes(needle));
  const assets = output.sort((a,b) => (meta(b.id).order || b.modified) - (meta(a.id).order || a.modified));
  assetViewCache = { key: cacheKey, assets };
  return assets;
}
function activeLabel() {
  if (currentView === 'tag-manager') return 'Manage tags';
  if (currentView === 'library-folders') return 'Library';
  if (currentView === 'settings') return 'Settings';
  if (currentView === 'discard-pile') return 'Discard Pile';
  if (currentView === 'locked-gallery') return 'Locked Gallery';
  if (currentCollection()) return currentCollection().name;
  if (currentSource()) return currentSource().name;
  return ({all:t('allMedia'), images:t('images'), videos:t('videos'), untagged:t('untagged')})[currentView] || t('library');
}
function applyLanguage() { document.documentElement.lang=store.language; $$('[data-i18n]').forEach(node=>node.textContent=t(node.dataset.i18n)); $('#searchInput').placeholder=t('search'); $('#viewOverline').textContent=t('library'); }
function applyZoom() { document.documentElement.style.setProperty('--thumb-height',`${store.zoom||155}px`); const label=$('#zoomValue');if(label)label.textContent=store.zoom||155; }
function updateSelectionUI() { const count=selectedIds.size, bulk=$('#bulkActions'), all=visibleAssets(); bulk.classList.toggle('hidden',count===0); $('#selectAll').textContent=count&&count===all.length?'☑':'□'; const group= count ? groupOf([...selectedIds][0]) : null; const sameGroup=group&&[...selectedIds].every(id=>group.assets.includes(id)); $('#dissolveGroup').classList.toggle('hidden',!sameGroup); }
function confirmAction(message) { return window.confirm(message); }
function normalizedTagName(value) { return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').trim().toLowerCase(); }
function confirmTypedTagRemoval(name, action) { openModal(`<h2>Xóa tag</h2><p>Nhập tên <b>${escapeHTML(name)}</b> để xác nhận. Không phân biệt hoa thường hoặc dấu tiếng Việt.</p><input id="typedTagRemoval" autocomplete="off" placeholder="${escapeHTML(name)}"><div class="modal-footer"><button data-close class="secondary-button">Hủy</button><button id="confirmTypedTagRemoval" class="danger-button">Xóa</button></div>`);const input=$('#typedTagRemoval'),submit=async()=>{if(normalizedTagName(input.value)!==normalizedTagName(name)){input.select();input.focus();return toast('Tên tag chưa khớp');}await action();closeModal();};$('#confirmTypedTagRemoval').onclick=submit;input.onkeydown=event=>{if(event.key==='Enter')submit();};requestAnimationFrame(()=>input.focus()); }
function render() {
  $('#viewTitle').textContent = activeLabel(); $('#viewOverline').textContent = currentView==='settings' ? 'SETTINGS' : currentCollection() ? t('privateFolder') : currentSource() ? t('source') : t('library');
  $('#editCollection').classList.toggle('hidden', !currentCollection());
  $('#addLibrarySource').classList.toggle('hidden', currentView !== 'all');
  const advancedFilterButton=$('#advancedFilter'),advancedFilterCount=advancedFilter.tags.length+advancedFilter.galleryIds.length+advancedFilter.sourceIds.length;
  advancedFilterButton.classList.toggle('hidden', ['tag-manager','library-folders','settings','discard-pile','locked-gallery'].includes(currentView));
  advancedFilterButton.textContent=`Filter${advancedFilterCount?` (${advancedFilterCount})`:''}`;
  const allMediaExcludeButton=$('#allMediaExcludeGalleries'),excludedGalleryCount=(store.allMediaExcludedGalleryIds||[]).length;
  allMediaExcludeButton.classList.toggle('hidden', currentView !== 'all');
  allMediaExcludeButton.textContent=`Exclude Gallery${excludedGalleryCount?` (${excludedGalleryCount})`:''}`;
  $('#assetCount').textContent = mainGalleryAssetCount();
  renderSidebars();
  if(currentView==='tag-manager'){ $('.toolbar').classList.add('hidden'); $('#inspector').classList.add('hidden'); renderTagScreen(); return; }
  if(currentView==='library-folders'){ $('.toolbar').classList.add('hidden'); $('#inspector').classList.add('hidden'); renderLibraryFolders(); return; }
  if(currentView==='settings'){ $('.toolbar').classList.add('hidden'); $('#inspector').classList.add('hidden'); renderSettings(); return; }
  if(currentView==='discard-pile'){ $('.toolbar').classList.add('hidden'); renderDiscardPile(); renderInspector(); return; }
  if(currentView==='locked-gallery'){ $('.toolbar').classList.add('hidden'); $('#inspector').classList.add('hidden'); renderLockedGallery(); return; }
  $('.toolbar').classList.remove('hidden'); renderCanvas(); renderInspector();
}
function openGallery(galleryId) {
  const gallery=store.collections.find(item=>item.id===galleryId);
  if(!gallery)return;
  if(gallery.locked&&!unlockedGalleryIds.has(gallery.id)){lockedGalleryId=gallery.id;currentView='locked-gallery';selectedId=null;selectedIds.clear();render();return;}
  currentView=`collection:${gallery.id}`;selectedId=null;selectedIds.clear();render();
}
function requestGalleryPassword(gallery, action) {
  if(!store.passwordHash)return toast('Set an app password before locking a Gallery');
  openModal(`<h2>Locked Gallery</h2><p>Enter the app password for “${escapeHTML(gallery.name)}”.</p><input id="galleryUnlockInput" type="password" autofocus placeholder="Password"><div class="modal-footer"><button class="secondary-button" data-close>Cancel</button><button id="galleryUnlockButton" class="primary-button">Continue</button></div>`);
  const input=$('#galleryUnlockInput'),verify=async()=>{if(await hash(input.value)===store.passwordHash){closeModal();action();}else{input.select();input.focus();toast('Incorrect password');}};
  $('#galleryUnlockButton').onclick=verify;input.onkeydown=event=>{if(event.key==='Enter')verify();};requestAnimationFrame(()=>input.focus());
}
function showGalleryUnlock(gallery) { requestGalleryPassword(gallery,()=>{unlockedGalleryIds.add(gallery.id);openGallery(gallery.id);}); }
function renderSidebars() {
  $$('.nav-item[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === currentView));
  $('#manageTags').classList.toggle('active',currentView==='tag-manager');
  const groups=store.galleryGroups||[],groupedIds=new Set(groups.flatMap(group=>group.galleries)),row=collection=>{const cover=allAssets.find(asset=>asset.id===(collection.coverId||collection.items[0]));if(cover)queueThumbnails([cover]);const preview=collection.locked&&!unlockedGalleryIds.has(collection.id)?'<span class="gallery-icon">🔒</span>':thumbnailImageHTML(cover,'folder-cover-mini')||'<span class="gallery-icon">▧</span>';return `<button draggable="true" class="collection-item ${currentView === 'collection:'+collection.id ? 'active':''}" data-collection="${collection.id}">${preview}<span class="item-text">${escapeHTML(collection.name)}</span><span class="collection-count">${collection.locked&&!unlockedGalleryIds.has(collection.id)?'?':collection.items.length}</span></button>`;};
  $('#collectionsList').innerHTML = `${groups.map(group=>`<section class="sidebar-gallery-group ${group.collapsed?'collapsed':''}" data-sidebar-gallery-group="${group.id}"><button class="sidebar-gallery-group-title" data-toggle-sidebar-group="${group.id}">▾ ${escapeHTML(group.title)} <span>${group.galleries.length}</span></button><div class="sidebar-gallery-group-members">${group.galleries.map(id=>store.collections.find(collection=>collection.id===id)).filter(Boolean).map(row).join('')}</div></section>`).join('')}${store.collections.filter(collection=>!groupedIds.has(collection.id)).map(row).join('')}` || '<p class="side-empty">Create your first Gallery</p>';
  $$('.collection-item').forEach(button => {button.addEventListener('click', event=>{const id=button.dataset.collection;if(event.ctrlKey||event.metaKey){selectedGalleryIds.has(id)?selectedGalleryIds.delete(id):selectedGalleryIds.add(id);renderSidebars();return;}openGallery(id);});button.addEventListener('contextmenu',event=>{event.preventDefault();if(!selectedGalleryIds.has(button.dataset.collection))selectedGalleryIds=new Set([button.dataset.collection]);openGalleryContextMenu(event,[...selectedGalleryIds]);});button.addEventListener('dragstart',event=>{galleryDragId=button.dataset.collection;event.dataTransfer.setData('text/plain',galleryDragId);});button.addEventListener('dragover',event=>event.preventDefault());button.addEventListener('drop',async event=>{event.preventDefault();if(galleryDragId&&galleryDragId!==button.dataset.collection)await createGalleryGroup([galleryDragId,button.dataset.collection]);});});
  $$('[data-toggle-sidebar-group]').forEach(button=>button.onclick=()=>{const group=groups.find(item=>item.id===button.dataset.toggleSidebarGroup);if(!group)return;group.collapsed=!group.collapsed;button.closest('.sidebar-gallery-group').classList.toggle('collapsed',group.collapsed);save();});
  $$('[data-sidebar-gallery-group]').forEach(node=>{node.addEventListener('dragover',event=>{if(galleryDragId)event.preventDefault();});node.addEventListener('drop',async event=>{event.preventDefault();const group=groups.find(item=>item.id===node.dataset.sidebarGalleryGroup);if(group&&galleryDragId)await createGalleryGroup([...group.galleries,galleryDragId]);});});
}
function renderSettings() {
  const canvas=$('#canvas'),empty=$('#emptyState');empty.classList.add('hidden');canvas.className='settings-screen';canvas.classList.remove('hidden');
  const discardedCount=store.collections.reduce((count,gallery)=>count+(gallery.discardedIds||[]).length,0)+(store.discardedGalleries||[]).length;
  canvas.innerHTML=`<h2>Settings</h2><p>Manage Gallery access and language for this Mosaic library.</p><div class="settings-list"><article class="settings-card"><div><h3>Profiles</h3><p>Current profile: <b>${escapeHTML(currentProfileInfo?.name || 'Default')}</b>. Each profile has its own library and media folder.</p></div><button id="settingsProfiles" class="secondary-button">Manage</button></article><article class="settings-card"><div><h3>Password</h3><p>${store.passwordHash?'Used only to lock and unlock Galleries.':'Set a password only if you want to lock a Gallery.'}</p></div><button id="settingsPassword" class="secondary-button">${store.passwordHash?'Change password':'Set password'}</button></article><article class="settings-card"><div><h3>Discard Pile</h3><p>${discardedCount} discarded Gallery item${discardedCount===1?'':'s'}.</p></div><button id="settingsDiscardPile" class="secondary-button">Open</button></article><article class="settings-card"><div><h3>Sync media location</h3><p>Move eligible media into its Gallery source folder.</p></div><button id="settingsSyncMediaLocations" class="secondary-button">Sync</button></article><article class="settings-card"><div><h3>Language</h3><p>${store.language==='vi'?'Tiếng Việt':'English'}</p></div><button id="settingsLanguage" class="secondary-button">Change language</button></article></div>`;
  $('#settingsProfiles').onclick=openProfilesModal;
  $('#settingsPassword').onclick=openPasswordModal;
  $('#settingsDiscardPile').onclick=()=>{currentView='discard-pile';selectedId=null;selectedIds.clear();render();};
  $('#settingsSyncMediaLocations').onclick=openMediaLocationSync;
  $('#settingsLanguage').onclick=openLanguageModal;
}
async function openProfilesModal() {
  const draw = async () => {
    const profiles = await window.vision.listProfiles();
    openModal(`<h2>Profiles</h2><p>Create separate libraries, then open each profile in its own window.</p><div class="profile-list">${profiles.map(profile => `<article class="profile-row"><div><b>${escapeHTML(profile.name)}</b>${profile.id===currentProfileInfo?.id?'<small>This window</small>':''}</div><div><button class="secondary-button" data-profile-open="${escapeHTML(profile.id)}">Open</button><button class="secondary-button" data-profile-shortcut="${escapeHTML(profile.id)}">Shortcut</button><button class="secondary-button" data-profile-rename="${escapeHTML(profile.id)}">Rename</button>${profile.isDefault?'<button class="secondary-button" disabled>Default</button>':`<button class="danger-button" data-profile-delete="${escapeHTML(profile.id)}">Delete</button>`}</div></article>`).join('')}</div><div class="new-tag-row profile-create-row"><input id="newProfileName" maxlength="80" placeholder="New profile name"><button id="createProfile" class="primary-button">Create</button></div><div class="modal-footer"><button data-close class="secondary-button">Close</button></div>`);
    $$('[data-profile-open]').forEach(button => button.onclick = async () => {
      await window.vision.openProfile(button.dataset.profileOpen);
      closeModal();
    });
    $$('[data-profile-shortcut]').forEach(button => button.onclick = async () => {
      try { const shortcutPath = await window.vision.createProfileShortcut(button.dataset.profileShortcut); toast(`Shortcut created: ${shortcutPath}`); }
      catch (error) { toast(error.message || 'Unable to create shortcut'); }
    });
    $$('[data-profile-rename]').forEach(button => button.onclick = async () => {
      const profile = profiles.find(item => item.id === button.dataset.profileRename);
      const name = window.prompt('Profile name', profile?.name || '');
      if (name == null) return;
      try {
        const renamed = await window.vision.renameProfile(button.dataset.profileRename, name);
        if (renamed.id === currentProfileInfo?.id) currentProfileInfo = renamed;
        await draw();
        renderSettings();
      } catch (error) { toast(error.message || 'Unable to rename profile'); }
    });
    $$('[data-profile-delete]').forEach(button => button.onclick = async () => {
      const profile = profiles.find(item => item.id === button.dataset.profileDelete);
      if (!profile || !confirmAction(`Remove profile “${profile.name}” from the app? Its files are kept on disk.`)) return;
      try { await window.vision.deleteProfile(profile.id); await draw(); }
      catch (error) { toast(error.message || 'Close the profile window before deleting it'); }
    });
    $('#createProfile').onclick = async () => {
      const input = $('#newProfileName');
      try {
        const profile = await window.vision.createProfile(input.value);
        input.value = '';
        await window.vision.openProfile(profile.id);
        closeModal();
      } catch (error) { toast(error.message || 'Unable to create profile'); }
    };
    $('#newProfileName').onkeydown = event => { if (event.key === 'Enter') $('#createProfile').click(); };
  };
  try { await draw(); } catch (error) { toast(error.message || 'Unable to load profiles'); }
}
function renderLockedGallery() {
  const canvas=$('#canvas'),empty=$('#emptyState'),gallery=store.collections.find(item=>item.id===lockedGalleryId);empty.classList.add('hidden');canvas.className='locked-gallery-screen';canvas.classList.remove('hidden');
  canvas.innerHTML=`<div class="gallery-lock-card"><div class="gallery-lock-icon">🔒</div><h2>Unlock to view contents</h2><p>${gallery?escapeHTML(gallery.name):'Locked Gallery'}</p><input id="lockedGalleryPassword" type="password" autofocus placeholder="Enter Password"><button id="unlockGalleryButton" class="primary-button">Mở Gallery</button><small id="lockedGalleryError"></small></div>`;
  const input=$('#lockedGalleryPassword'),button=$('#unlockGalleryButton'),unlock=async()=>{if(!gallery)return;button.disabled=true;const valid=await hash(input.value)===store.passwordHash;if(valid){unlockedGalleryIds.add(gallery.id);lockedGalleryId=null;openGallery(gallery.id);return;}button.disabled=false;$('#lockedGalleryError').textContent='Mật khẩu không chính xác';input.select();input.focus();};
  button.onclick=unlock;input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();unlock();}};requestAnimationFrame(()=>input.focus());
}
function discardEntries() { return store.collections.flatMap(gallery=>(gallery.discardedIds||[]).map(assetId=>({gallery,asset:allAssets.find(asset=>asset.id===assetId)})).filter(entry=>entry.asset)); }
async function restoreDiscardedGallery(galleryId) { const gallery=(store.discardedGalleries||[]).find(item=>item.id===galleryId);if(!gallery)return;store.collections.push(gallery);store.discardedGalleries=store.discardedGalleries.filter(item=>item.id!==galleryId);await save();render(); }
async function permanentlyDeleteDiscardedGallery(galleryId) { const gallery=(store.discardedGalleries||[]).find(item=>item.id===galleryId);if(!gallery||!confirmAction(`Permanently delete Gallery “${gallery.name}” from Discard Pile? Media files will be kept.`))return;store.discardedGalleries=store.discardedGalleries.filter(item=>item.id!==galleryId);await save();render(); }
async function restoreDiscardEntry(gallery,assetId) { gallery.discardedIds=(gallery.discardedIds||[]).filter(id=>id!==assetId);await save();selectedId=null;selectedIds.clear();discardOriginGalleryId=null;render(); }
async function permanentlyDeleteDiscardEntry(gallery,assetId) { const asset=allAssets.find(item=>item.id===assetId);if(!asset||!confirmAction(`Permanently delete “${asset.name}” from disk? This cannot be undone.`))return;const removed=await window.vision.permanentDelete(asset);if(!removed)return toast('Unable to permanently delete this file');for(const source of store.sources)await scanSource(source);await collectAssets();[...store.collections,...(store.discardedGalleries||[])].forEach(item=>{item.items=(item.items||[]).filter(id=>id!==assetId);item.discardedIds=(item.discardedIds||[]).filter(id=>id!==assetId);item.groups=(item.groups||[]).map(group=>({...group,assets:group.assets.filter(id=>id!==assetId)})).filter(group=>group.assets.length>1);});await save();selectedId=null;selectedIds.clear();discardOriginGalleryId=null;render(); }
function renderDiscardPile() {
  const canvas=$('#canvas'),empty=$('#emptyState'),entries=discardEntries(),galleries=store.discardedGalleries||[];empty.classList.add('hidden');canvas.className='discard-pile';canvas.classList.remove('hidden');
  queueThumbnails(entries.slice(0, THUMBNAIL_BATCH_SIZE).map(entry => entry.asset));
  const galleryCards=galleries.map(gallery=>`<article class="discard-card discard-gallery-card" data-discard-gallery-record="${gallery.id}"><div class="discard-preview discard-gallery-preview">▧</div><div class="discard-meta"><b>Gallery: ${escapeHTML(gallery.name)}</b><small>${(gallery.items||[]).length} media</small><div><button data-discard-gallery-restore>Restore Gallery</button><button data-discard-gallery-delete class="context-danger">Permanent Delete</button></div></div></article>`).join('');
  const mediaCards=entries.map(({gallery,asset})=>`<article class="discard-card" data-discard-asset="${asset.id}" data-discard-gallery="${gallery.id}"><div class="discard-preview">${thumbnailImageHTML(asset)||`<div class="asset-placeholder">${asset.type==='video'?'▷':'…'}</div>`}</div><div class="discard-meta"><b>${escapeHTML(asset.name)}</b><small>Gallery: ${escapeHTML(gallery.name)}</small><div><button data-discard-restore>Restore</button><button data-discard-delete class="context-danger">Permanent Delete</button></div></div></article>`).join('');
  canvas.innerHTML=galleryCards||mediaCards?galleryCards+mediaCards:'<div class="canvas-empty">Discard Pile is empty.</div>';
  $$('[data-discard-asset]').forEach(card=>card.onclick=()=>{selectedId=card.dataset.discardAsset;selectedIds=new Set([selectedId]);discardOriginGalleryId=card.dataset.discardGallery;$('#inspector').classList.remove('hidden');renderInspector();});
  $$('[data-discard-restore]').forEach(button=>button.onclick=event=>{event.stopPropagation();const card=button.closest('[data-discard-asset]'),gallery=store.collections.find(item=>item.id===card.dataset.discardGallery);restoreDiscardEntry(gallery,card.dataset.discardAsset);});
  $$('[data-discard-delete]').forEach(button=>button.onclick=event=>{event.stopPropagation();const card=button.closest('[data-discard-asset]'),gallery=store.collections.find(item=>item.id===card.dataset.discardGallery);permanentlyDeleteDiscardEntry(gallery,card.dataset.discardAsset);});
  $$('[data-discard-gallery-restore]').forEach(button=>button.onclick=event=>{event.stopPropagation();restoreDiscardedGallery(button.closest('[data-discard-gallery-record]').dataset.discardGalleryRecord);});
  $$('[data-discard-gallery-delete]').forEach(button=>button.onclick=event=>{event.stopPropagation();permanentlyDeleteDiscardedGallery(button.closest('[data-discard-gallery-record]').dataset.discardGalleryRecord);});
}
function renderTagScreen() {
  const canvas=$('#canvas'), empty=$('#emptyState'), gallery=store.collections.find(item=>item.id===tagManagerGalleryId), groups=gallery?managedTagGroups(gallery):tagGroups(), group=groups.find(item=>item.id===tagManagerKind)||groups[0], definitions=tagGroupDefinitions(group);
  tagManagerKind=group.id; empty.classList.add('hidden'); canvas.className='tag-screen'; canvas.classList.remove('hidden');
  const byLetter={};definitions.forEach(definition=>{const letter=(definition.name[0]||'#').toUpperCase();(byLetter[letter]||=[]).push(definition);});
  canvas.innerHTML=`<aside class="tag-screen-tabs"><button data-tag-manager-gallery="" class="${!gallery?'active':''}">General Tag</button><div class="tag-manager-side-label">GALLERY TAG</div>${store.collections.map(item=>`<button data-tag-manager-gallery="${item.id}" class="${gallery?.id===item.id?'active':''}">${escapeHTML(item.name)}</button>`).join('')}<div class="tag-manager-side-label">${gallery?'EXCLUSIVE TAG':'GENERAL TAG GROUP'}</div>${groups.map(item=>`<button data-screen-kind="${item.id}" class="${item.id===group.id?'active':''}">${escapeHTML(item.name)} <span>${tagGroupDefinitions(item).length}</span></button>`).join('')}<button id="createTagGroup" class="tag-group-create">＋ New tag group</button></aside><section class="tag-screen-main"><div class="tag-screen-title"><div><p class="eyebrow">${gallery?`GALLERY TAG · ${escapeHTML(gallery.name)}`:'TAG GROUP'}</p><h2>${escapeHTML(group.name)}</h2></div><div class="new-tag-row"><input id="screenNewTag" placeholder="Create ${escapeHTML(group.name)} tag"><button id="screenCreateTag" class="primary-button">Create</button></div></div><div class="tag-directory">${Object.keys(byLetter).sort().map(letter=>`<section><h3>${letter}</h3>${byLetter[letter].sort((a,b)=>a.name.localeCompare(b.name)).map(definition=>`<div class="tag-directory-row"><input class="tag-name-input" data-edit-name="${escapeHTML(definition.name)}" value="${escapeHTML(definition.name)}"><span>${allAssets.filter(asset=>tagGroupValues(meta(asset.id),group).includes(definition.name)).length} media</span><button data-delete-definition="${escapeHTML(definition.name)}">×</button></div>`).join('')}</section>`).join('')||'<div class="tag-directory-empty">No values yet. Create your first one above.</div>'}</div></section>`;
  $$('[data-screen-kind]').forEach(button=>button.onclick=()=>{tagManagerKind=button.dataset.screenKind;renderTagScreen();});
  $$('[data-tag-manager-gallery]').forEach(button=>button.onclick=()=>{tagManagerGalleryId=button.dataset.tagManagerGallery||null;tagManagerKind=(tagManagerGalleryId?managedTagGroups(store.collections.find(item=>item.id===tagManagerGalleryId)):tagGroups())[0]?.id||'theme';renderTagScreen();});
  $('#createTagGroup').onclick=async()=>{const name=window.prompt('Tên nhóm tag mới');if(!name?.trim()||groups.some(item=>item.name.toLowerCase()===name.trim().toLowerCase()))return;const next={id:uid(),name:name.trim(),values:[],enabled:true};if(gallery)gallery.exclusiveTagGroups.push(next);else{store.tagGroups.push(next);store.collections.forEach(collection=>{collection.generalTagGroupIds ||= [];if(!collection.generalTagGroupIds.includes(next.id))collection.generalTagGroupIds.push(next.id);});}tagManagerKind=next.id;await save();renderTagScreen();};
  $('#screenCreateTag').onclick=async()=>{const name=$('#screenNewTag').value.trim();if(!name||definitions.some(item=>item.name.toLowerCase()===name.toLowerCase()))return;definitions.push({name});await save();renderTagScreen();};
  $$('[data-delete-definition]').forEach(button=>button.onclick=()=>{const name=button.dataset.deleteDefinition;confirmTypedTagRemoval(name,async()=>{const index=definitions.findIndex(item=>item.name===name);if(index>=0)definitions.splice(index,1);replaceTagGroupValue(group,name,null);await save();renderTagScreen();});});
  $$('[data-edit-name]').forEach(input=>input.onchange=async()=>{const old=input.dataset.editName,next=input.value.trim();if(!next||old===next)return;const definition=definitions.find(item=>item.name===old);if(definition)definition.name=next;replaceTagGroupValue(group,old,next);await save();renderTagScreen();});
}
function galleryGroupOf(galleryId) { return (store.galleryGroups||[]).find(group=>group.galleries.includes(galleryId)); }
function dissolveSmallGalleryGroups() { store.galleryGroups=(store.galleryGroups||[]).filter(group=>(group.galleries||[]).length>1); }
async function createGalleryGroup(galleryIds) { const ids=[...new Set(galleryIds)].filter(id=>store.collections.some(gallery=>gallery.id===id));if(ids.length<2)return;const existing=(store.galleryGroups||[]).find(group=>ids.some(id=>group.galleries.includes(id)));if(existing){ids.forEach(id=>{store.galleryGroups.forEach(group=>{if(group!==existing)group.galleries=group.galleries.filter(item=>item!==id);});if(!existing.galleries.includes(id))existing.galleries.push(id);});}else{store.galleryGroups.push({id:uid(),title:'Gallery group',galleries:ids,order:Date.now()});}dissolveSmallGalleryGroups();await save();render();}
async function removeGalleryFromGroup(galleryId) { const group=galleryGroupOf(galleryId);if(!group)return;group.galleries=group.galleries.filter(id=>id!==galleryId);dissolveSmallGalleryGroups();await save();render();}
async function reorderGallery(movedId,targetId) { if(!movedId||movedId===targetId)return;const ordered=[...store.collections].sort((a,b)=>(b.order||0)-(a.order||0)),moved=ordered.find(gallery=>gallery.id===movedId),targetIndex=ordered.findIndex(gallery=>gallery.id===targetId);if(!moved||targetIndex<0)return;ordered.splice(ordered.indexOf(moved),1);ordered.splice(targetIndex,0,moved);ordered.forEach((gallery,index)=>gallery.order=Date.now()-index);await save();render(); }
function galleryCardHTML(collection, compact=false) { const cover=allAssets.find(asset=>asset.id===(collection.coverId||collection.items[0]));if(cover)queueThumbnails([cover]);const locked=collection.locked&&!unlockedGalleryIds.has(collection.id),coverImage=thumbnailImageHTML(cover);const preview=locked?`<div class="locked-gallery-preview">${coverImage||'<span>▧</span>'}<i>🔒</i></div>`:coverImage||'<span>▧</span>';return `<button draggable="true" class="folder-gallery-card ${compact?'folder-gallery-card-compact':''} ${selectedGalleryIds.has(collection.id)?'selected':''}" data-library-folder="${collection.id}">${preview}<div><b>${locked?'🔒 ':''}${escapeHTML(collection.name)}</b>${locked?'<small>Locked</small>':`<small>${collection.items.length} media</small>`}</div></button>`; }
function openGalleryGroupPopup(group) { const galleries=group.galleries.map(id=>store.collections.find(gallery=>gallery.id===id)).filter(Boolean);openModal(`<div class="gallery-group-popup"><h2>${escapeHTML(group.title)}</h2><p>${galleries.length} Galleries</p><div class="gallery-group-popup-grid">${galleries.map(gallery=>galleryCardHTML(gallery)).join('')}</div><div class="modal-footer"><button data-close class="secondary-button">Đóng</button></div></div>`);bindLibraryGalleryCards($('#modal')); }
function bindLibraryGalleryCards(scope=document) { [...scope.querySelectorAll('[data-library-folder]')].forEach(card=>{const id=card.dataset.libraryFolder;card.onclick=event=>{event.stopPropagation();if(event.ctrlKey||event.metaKey){selectedGalleryIds.has(id)?selectedGalleryIds.delete(id):selectedGalleryIds.add(id);renderLibraryFolders();return;}if(scope===$('#modal'))closeModal();openGallery(id);};card.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();if(!selectedGalleryIds.has(id))selectedGalleryIds=new Set([id]);openGalleryContextMenu(event,[...selectedGalleryIds]);};card.ondragstart=event=>{galleryDragId=id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',id);card.classList.add('dragging');};card.ondragend=()=>{galleryDragId=null;clearTimeout(galleryGroupTimer);$$('.folder-gallery-card').forEach(item=>item.classList.remove('group-target','dragging'));};card.ondragenter=event=>{if(!galleryDragId||galleryDragId===id)return;event.preventDefault();card.classList.add('group-target');clearTimeout(galleryGroupTimer);galleryGroupTimer=setTimeout(()=>{const first=galleryDragId;galleryDragId=null;if(first)createGalleryGroup([first,id]);},1500);};card.ondragleave=()=>{card.classList.remove('group-target');clearTimeout(galleryGroupTimer);};card.ondragover=event=>event.preventDefault();card.ondrop=async event=>{event.preventDefault();clearTimeout(galleryGroupTimer);const moved=galleryDragId;galleryDragId=null;if(moved&&moved!==id)await reorderGallery(moved,id);};}); }
function renderLibraryFolders() { const canvas=$('#canvas'),empty=$('#emptyState');empty.classList.add('hidden');canvas.className='folder-gallery';canvas.classList.remove('hidden');const groups=[...(store.galleryGroups||[])].sort((a,b)=>(b.order||0)-(a.order||0)),groupedIds=new Set(groups.flatMap(group=>group.galleries));const groupCards=groups.map(group=>{const members=group.galleries.map(id=>store.collections.find(gallery=>gallery.id===id)).filter(Boolean).sort((a,b)=>(b.order||0)-(a.order||0));return `<article class="gallery-group-card" data-gallery-group="${group.id}"><div class="gallery-group-preview">${members.slice(0,4).map(gallery=>galleryCardHTML(gallery,true)).join('')}</div><div><b>${escapeHTML(group.title)}</b><small>${members.length} Galleries</small></div></article>`;}).join('');const cards=store.collections.filter(collection=>!groupedIds.has(collection.id)).sort((a,b)=>(b.order||0)-(a.order||0)).map(collection=>galleryCardHTML(collection)).join('');canvas.innerHTML=groupCards||cards?groupCards+cards:'<div class="canvas-empty">No Galleries yet.</div>';bindLibraryGalleryCards(canvas);$$('[data-gallery-group]').forEach(button=>{button.onclick=()=>{const group=groups.find(item=>item.id===button.dataset.galleryGroup);if(group)openGalleryGroupPopup(group);};button.ondragover=event=>event.preventDefault();button.ondrop=async event=>{event.preventDefault();if(!galleryDragId)return;const group=groups.find(item=>item.id===button.dataset.galleryGroup);if(!group)return;await createGalleryGroup([...group.galleries,galleryDragId]);};});canvas.ondragover=event=>{if(galleryDragId)event.preventDefault();};canvas.ondrop=async event=>{if(!galleryDragId||event.target!==canvas)return;event.preventDefault();await removeGalleryFromGroup(galleryDragId);}; }
function queueThumbnails(assets, priority = false) {
  const candidates = assets.filter(asset => ['image', 'video'].includes(asset?.type) && !thumbnailMemory.has(thumbnailKey(asset)) && !thumbnailQueued.has(thumbnailKey(asset)) && !thumbnailFailed.has(thumbnailKey(asset)));
  if (!candidates.length) return;
  candidates.forEach(asset => thumbnailQueued.add(thumbnailKey(asset)));
  if (priority) thumbnailQueue.unshift(...candidates);
  else thumbnailQueue.push(...candidates);
  scheduleThumbnailQueue();
}
function scheduleThumbnailQueue() {
  if (thumbnailQueueRunning || thumbnailQueueScheduled || !thumbnailQueue.length) return;
  thumbnailQueueScheduled = true;
  const run = () => { thumbnailQueueScheduled = false; drainThumbnailQueue(); };
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 180 });
  else setTimeout(run, 16);
}
function hydrateThumbnailCards(thumbnails) {
  Object.entries(thumbnails).forEach(([id, url]) => {
    $$('.asset-card').filter(card => card.dataset.id === id).map(card => card.querySelector('.asset-placeholder')).filter(Boolean).forEach(placeholder => {
      const image = document.createElement('img');
      image.src = url;
      image.loading = 'lazy';
      image.alt = '';
      image.addEventListener('load', scheduleMasonry, { once: true });
      placeholder.replaceWith(image);
    });
  });
  scheduleMasonry();
}
async function drainThumbnailQueue() {
  if (thumbnailQueueRunning) return;
  const batch = thumbnailQueue.splice(0, THUMBNAIL_BATCH_SIZE);
  if (!batch.length) return;
  thumbnailQueueRunning = true;
  try {
    const thumbnails = await window.vision.ensureThumbnails(batch.map(asset => ({ id: asset.id, path: asset.path, contentUrl: asset.contentUrl, vault: asset.vault, modified: asset.modified, type: asset.type })));
    const urls = thumbnails || {};
    batch.forEach(asset => {
      const key = thumbnailKey(asset);
      thumbnailQueued.delete(key);
      if (urls[asset.id]) thumbnailMemory.set(key, urls[asset.id]);
      else thumbnailFailed.add(key);
    });
    hydrateThumbnailCards(urls);
    // Covers and special screens use the same memory cache, never an original.
    renderSidebars();
    if (currentView === 'library-folders') renderLibraryFolders();
    if (currentView === 'discard-pile') renderDiscardPile();
  } catch {
    batch.forEach(asset => { thumbnailQueued.delete(thumbnailKey(asset)); thumbnailFailed.add(thumbnailKey(asset)); });
  } finally {
    thumbnailQueueRunning = false;
    scheduleThumbnailQueue();
  }
}
function prefetchCanvasThumbnails(assets) {
  const start = canvasScrollDirection === 'up' ? Math.max(0, canvasRenderLimit - CANVAS_BATCH_SIZE * 2) : canvasRenderLimit;
  queueThumbnails(assets.slice(start, start + THUMBNAIL_BATCH_SIZE));
}
function queueNextCanvasBatch() {
  const total = visibleAssets().length;
  if (canvasBatchQueued || canvasRenderLimit >= total) return;
  canvasBatchQueued = true;
  const button = $('#loadMoreAssets');
  if (button) { button.disabled = true; button.textContent = 'Đang tải 50 media…'; }
  // Give the current cards a chance to paint before binding another batch.
  requestAnimationFrame(() => {
    canvasRenderLimit = Math.min(total, canvasRenderLimit + CANVAS_BATCH_SIZE);
    canvasBatchQueued = false;
    renderCanvas();
  });
}
function cardHTML(asset, groupCard = false) {
  const isVideo = asset.type === 'video';
  const url = gridMediaURL(asset);
  const preview = url ? `<img src="${url}" loading="lazy" alt="${escapeHTML(asset.name)}" />` : `<div class="asset-placeholder">${isVideo ? '▷' : '…'}</div>`;
  return `<article class="asset-card ${groupCard ? 'group-card':''} ${selectedIds.has(asset.id) ? 'selected':''}" draggable="true" data-id="${asset.id}" ${groupCard ? '' : `data-layout-key="asset:${asset.id}"`}>${preview}${isVideo ? '<span class="type-badge video-badge" title="Video">▷</span>' : ''}${meta(asset.id).favorite ? '<span class="fav-badge">★</span>' : ''}</article>`;
}
function renderCanvas() {
  const allVisibleAssets = visibleAssets(), canvas = $('#canvas'), empty = $('#emptyState');
  const resultKey = `${assetRevision}|${currentView}|${currentFilter}|${searchTerm}`;
  if (resultKey !== canvasResultKey) { canvasResultKey = resultKey; canvasRenderLimit = CANVAS_BATCH_SIZE; canvasBatchQueued = false; }
  const assets = allVisibleAssets.slice(0, canvasRenderLimit);
  canvas.className='asset-canvas';
  empty.classList.toggle('hidden', allAssets.length > 0); canvas.classList.toggle('hidden', allAssets.length === 0);
  if (!allAssets.length) return;
  const groups=activeGroups(), visibleIds=new Set(assets.map(asset=>asset.id)), grouped=new Set(groups.flatMap(group=>group.assets));
  const groupColumns=Math.max(1,Math.floor((canvas.clientWidth-85)/168));
  const layout=[...groups.map(group=>({kind:'group',group,members:group.assets.map(id=>allAssets.find(asset=>asset.id===id)).filter(asset=>asset&&visibleIds.has(asset.id)),rank:group.order||0})).filter(item=>item.members.length),...assets.filter(asset=>!grouped.has(asset.id)).map(asset=>({kind:'asset',asset,rank:meta(asset.id).order||asset.modified}))].sort((a,b)=>b.rank-a.rank);
  let html=layout.map(item=>item.kind==='asset' ? cardHTML(item.asset) : `<section class="group-shell ${item.group.collapsed?'collapsed':''}" style="--group-rows:${Math.ceil(item.members.length/groupColumns)}" data-group="${item.group.id}" data-layout-key="group:${item.group.id}"><button class="group-drag-handle" draggable="true" title="Kéo cả nhóm">⠿</button><div class="group-members">${(item.group.collapsed?item.members.filter(asset=>asset.id===(item.group.coverId||item.members[0]?.id)):item.members).map(asset=>cardHTML(asset,true)).join('')}</div><span class="group-count">${item.members.length}</span></section>`).join('');
  if (!html) html = '<div class="canvas-empty">Không có media phù hợp với bộ lọc này.</div>';
  if (assets.length < allVisibleAssets.length) html += `<button class="load-more-assets" id="loadMoreAssets">Tải 50 media tiếp theo (${assets.length}/${allVisibleAssets.length})</button>`;
  canvas.innerHTML = html;
  $('#loadMoreAssets')?.addEventListener('click', queueNextCanvasBatch);
  justifiedObserver ||= new ResizeObserver(scheduleMasonry);justifiedObserver.disconnect();justifiedObserver.observe(canvas);
  $$('.group-shell.collapsed').forEach(group=>{group.draggable=true;});
  canvas.addEventListener('dragover',event=>{if(event.target===canvas&&dragId&&groupOf(dragId)){event.preventDefault();scheduleUngroup(dragId,null);}});
  $$('.asset-card').forEach(card => {
    card.addEventListener('click', event => { event.stopPropagation(); discardOriginGalleryId=null; const id=card.dataset.id; if(event.ctrlKey||event.metaKey){selectedIds.has(id)?selectedIds.delete(id):selectedIds.add(id);}else {selectedIds=new Set([id]);} selectedId=selectedIds.has(id)?id:[...selectedIds].at(-1)||null; $$('.asset-card').forEach(item=>item.classList.toggle('selected',selectedIds.has(item.dataset.id))); $('#inspector').classList.toggle('hidden',!selectedId); updateSelectionUI(); renderInspector(); });
    card.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); openLightbox(card.dataset.id); });
    card.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); const id=card.dataset.id;if(!selectedIds.has(id)){selectedIds=new Set([id]);selectedId=id;$$('.asset-card').forEach(item=>item.classList.toggle('selected',item.dataset.id===id));renderInspector();updateSelectionUI();}openContextMenu(event,id); });
    card.addEventListener('dragstart', event => { dragGroupId=null; dragId = card.dataset.id; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); clearHover(); stopAutoScroll(); dragId = null; dragGroupId=null; if(ungroupedDuringDrag){ungroupedDuringDrag=false;render();} });
    card.addEventListener('dragenter', event => { if ((!dragId&&!dragGroupId) || dragId === card.dataset.id) return; event.preventDefault(); });
    card.addEventListener('dragover', event => { event.preventDefault(); const collapsedGroup=card.closest('.group-shell.collapsed'); if (!card.classList.contains('group-card') || collapsedGroup) dragGroupId ? setGroupDropTarget(card,event) : setDropTarget(card,event); });
    card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) { clearHover(); clearDropMarkers(); } });
    card.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); const intent=card.dataset.dropIntent,collapsedGroup=card.closest('.group-shell.collapsed'); clearHover(); clearDropMarkers(); if (dragGroupId && collapsedGroup) { if (dragGroupId !== collapsedGroup.dataset.group) return reorderLayout(`group:${dragGroupId}`,`group:${collapsedGroup.dataset.group}`,intent === 'after'||intent === 'below'); return; } if (dragGroupId && !card.classList.contains('group-card')) return reorderLayout(`group:${dragGroupId}`,`asset:${card.dataset.id}`,intent === 'after'||intent === 'below'); if (!dragId || dragId === card.dataset.id) return; if (card.classList.contains('group-card')) addToGroup(dragId,card.closest('.group-shell').dataset.group); else if (intent === 'group') createGroup(dragId,card.dataset.id); else reorder(dragId,card.dataset.id,intent === 'after'); });
  });
  $$('.group-shell').forEach(group => {
    group.addEventListener('dragover', event => { event.preventDefault(); group.classList.add('drag-over'); });
    group.addEventListener('dragleave', () => group.classList.remove('drag-over'));
    group.addEventListener('drop', event => { event.preventDefault(); group.classList.remove('drag-over'); if(dragId)addToGroup(dragId, group.dataset.group); });
    group.addEventListener('contextmenu',event=>{if(event.target.closest('.asset-card')&&!group.classList.contains('collapsed'))return;event.preventDefault();openGroupContextMenu(event,group.dataset.group);});
  });
  $$('.group-shell.collapsed').forEach(group=>{
    group.addEventListener('dragstart',event=>{event.stopPropagation();dragId=null;dragGroupId=group.dataset.group;group.classList.add('dragging');event.dataTransfer.effectAllowed='move';},true);
    group.addEventListener('dragend',event=>{event.stopPropagation();group.classList.remove('dragging');dragGroupId=null;clearDropMarkers();stopAutoScroll();},true);
  });
  $$('.group-drag-handle').forEach(handle=>{handle.addEventListener('dragstart',event=>{dragId=null;dragGroupId=handle.closest('.group-shell').dataset.group;handle.closest('.group-shell').classList.add('dragging');event.dataTransfer.effectAllowed='move';});handle.addEventListener('dragend',()=>{handle.closest('.group-shell').classList.remove('dragging');dragGroupId=null;clearDropMarkers();stopAutoScroll();});});
  $$('.asset-card img,.asset-card video').forEach(media=>{media.addEventListener('load',scheduleMasonry);media.addEventListener('loadedmetadata',scheduleMasonry);}); scheduleMasonry();
  enableMarqueeSelection(canvas);
  updateSelectionUI();
  queueThumbnails(assets, true);
  prefetchCanvasThumbnails(allVisibleAssets);
}
function scheduleMasonry() {
  if(masonryFrame)return;
  masonryFrame=requestAnimationFrame(()=>{
    masonryFrame=null;
    const canvas=$('#canvas');if(!canvas?.classList.contains('asset-canvas'))return;
    const gap=10,targetHeight=Math.min(MAX_GRID_MEDIA_HEIGHT,store.zoom||155),width=Math.max(1,canvas.clientWidth-68);
    let row=[];
    const ratioOf=node=>{const media=node.querySelector('img,video');const width=media?.naturalWidth||media?.videoWidth||0,height=media?.naturalHeight||media?.videoHeight||0;return width&&height?width/height:1;};
    const applyRow=(last=false)=>{
      if(!row.length)return;
      const ratio=row.reduce((sum,item)=>sum+item.ratio,0);
      const height=last?targetHeight:(width-gap*(row.length-1))/ratio;
      row.forEach(item=>{const cardWidth=Math.max(42,height*item.ratio);item.node.style.setProperty('--thumb-height',`${height}px`);item.node.style.setProperty('--thumb-width',`${cardWidth}px`);item.node.style.setProperty('width',`${cardWidth}px`,'important');item.node.style.setProperty('flex-basis',`${cardWidth}px`,'important');});
      row=[];
    };
    [...canvas.children].forEach(node=>{
      if(!node.classList.contains('asset-card')){applyRow();return;}
      const ratio=ratioOf(node);row.push({node,ratio});
      if(row.reduce((sum,item)=>sum+item.ratio,0)*targetHeight+gap*(row.length-1)>=width)applyRow();
    });
    applyRow(true);
  });
}
function enableMarqueeSelection(canvas) { canvas.onpointerdown=event=>{if(event.button!==0||event.target!==canvas)return;const origin={x:event.clientX,y:event.clientY};const box=document.createElement('div');box.className='selection-marquee';document.body.append(box);const update=move=>{const left=Math.min(origin.x,move.clientX),top=Math.min(origin.y,move.clientY),right=Math.max(origin.x,move.clientX),bottom=Math.max(origin.y,move.clientY);Object.assign(box.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});selectedIds=new Set($$('.asset-card').filter(card=>{const r=card.getBoundingClientRect();return r.left<right&&r.right>left&&r.top<bottom&&r.bottom>top;}).map(card=>card.dataset.id));selectedId=[...selectedIds].at(-1)||null;$$('.asset-card').forEach(card=>card.classList.toggle('selected',selectedIds.has(card.dataset.id)));};const end=()=>{box.remove();window.removeEventListener('pointermove',update);window.removeEventListener('pointerup',end);$('#inspector').classList.toggle('hidden',!selectedId);updateSelectionUI();renderInspector();};window.addEventListener('pointermove',update);window.addEventListener('pointerup',end,{once:true});}; }
function updateAutoScroll(event) { const content=$('#content'), rect=content.getBoundingClientRect(), edge=92; const topDistance=event.clientY-rect.top, bottomDistance=rect.bottom-event.clientY; if(topDistance<edge)autoScrollVelocity=-Math.max(4,Math.round((edge-topDistance)/edge*22)); else if(bottomDistance<edge)autoScrollVelocity=Math.max(4,Math.round((edge-bottomDistance)/edge*22)); else { stopAutoScroll(); return; } if(autoScrollFrame)return; const step=()=>{const before=content.scrollTop;content.scrollTop+=autoScrollVelocity;if(content.scrollTop===before){stopAutoScroll();return;}autoScrollFrame=requestAnimationFrame(step);};autoScrollFrame=requestAnimationFrame(step); }
function stopAutoScroll() { autoScrollVelocity=0;if(autoScrollFrame){cancelAnimationFrame(autoScrollFrame);autoScrollFrame=null;} }
function clearHover() { clearTimeout(hoverTimer); hoverTimer = null; hoverTargetId = null; document.body.classList.remove('drag-holding'); $$('.hold-progress').forEach(item=>item.remove()); $$('.asset-card').forEach(card => card.classList.remove('group-target','ungroup-target')); }
function clearDropMarkers() { $$('.asset-card').forEach(card => { card.classList.remove('drop-before','drop-after','drop-above','drop-below'); delete card.dataset.dropIntent; }); }
function setGroupDropTarget(card,event) { clearDropMarkers(); const rect=card.getBoundingClientRect(); const x=(event.clientX-rect.left)/rect.width, y=(event.clientY-rect.top)/rect.height; let intent='before'; if(y<.24)intent='above'; else if(y>.76)intent='below'; else if(x>.5)intent='after'; card.classList.add({before:'drop-before',after:'drop-after',above:'drop-above',below:'drop-below'}[intent]); card.dataset.dropIntent=intent; }
function setDropTarget(card,event) { clearDropMarkers(); const rect=card.getBoundingClientRect(),localX=event.clientX-rect.left,localY=event.clientY-rect.top; const center=localX>20&&localX<rect.width-20&&localY>20&&localY<rect.height-20; if (center) { card.dataset.dropIntent='group'; card.classList.add('group-target'); scheduleGrouping(dragId,card.dataset.id); return; } const after=localX>rect.width/2; card.classList.add(after?'drop-after':'drop-before'); card.dataset.dropIntent=after?'after':'before'; if(groupOf(dragId))scheduleUngroup(dragId,card.dataset.id);else clearHover(); }
function scheduleGrouping(first, second) {
  if (dragGroupId || (hoverTimer && hoverTargetId === second)) return;
  clearHover(); hoverTargetId=second;
  const target = $(`.asset-card[data-id="${second}"]`); target?.classList.add('group-target');target?.insertAdjacentHTML('beforeend','<span class="hold-progress"></span>');
  const deadline=performance.now()+3000; document.body.classList.add('drag-holding'); hoverTimer=setTimeout(()=>{if(performance.now()>=deadline)createGroup(first,second);clearHover();},Math.max(0,deadline-performance.now()));
}
async function createGroup(first, second) {
  const groups=activeGroups(); if (first === second) return;
  const existing = groups.find(group => group.assets.includes(first) || group.assets.includes(second));
  if (existing) { [first,second].forEach(id => { if (!existing.assets.includes(id)) existing.assets.push(id); }); }
  else groups.push({ id:uid(), title:'Nhóm mới', assets:[first,second], order:Math.max(meta(first).order||0,meta(second).order||0) });
  await save(); toast('Đã tạo nhóm ảnh'); render();
}
async function addToGroup(assetId, groupId) {
  const groups=activeGroups(), group = groups.find(item => item.id === groupId); if (!assetId || !group) return;
  groups.forEach(item => item.assets = item.assets.filter(id => id !== assetId)); if (!group.assets.includes(assetId)) group.assets.push(assetId);
  dissolveSingletonGroups();
  await save(); toast('Đã thêm vào nhóm'); render();
}
function groupOf(assetId) { return activeGroups().find(group=>group.assets.includes(assetId)); }
function scheduleUngroup(assetId,targetId) { clearHover();if(!groupOf(assetId))return;removeFromGroup(assetId,targetId,true); }
function dissolveSingletonGroups() { const groups=activeGroups(); for(let index=groups.length-1;index>=0;index--)if((groups[index].assets||[]).length<2)groups.splice(index,1); }
async function removeFromGroup(assetId,targetId,deferRender=false) { const group=groupOf(assetId);if(!group)return;group.assets=group.assets.filter(id=>id!==assetId);dissolveSingletonGroups();if(targetId)meta(assetId).order=(meta(targetId).order||Date.now())+.5;else meta(assetId).order=Math.min(...visibleAssets().map(asset=>meta(asset.id).order||asset.modified),Date.now())-1;if(deferRender)ungroupedDuringDrag=true;await save();if(deferRender)return;toast('Đã tách ảnh khỏi nhóm');render(); }
async function removeFromGroupAfterCurrent(assetId) { const group=groupOf(assetId);if(!group)return;group.assets=group.assets.filter(id=>id!==assetId);dissolveSingletonGroups();meta(assetId).order=(group.order||Date.now())-.1;await save();toast('Đã tách ảnh khỏi nhóm');render(); }
async function createSingleGroup(assetId) { if(groupOf(assetId))return;activeGroups().push({id:uid(),title:'',assets:[assetId],order:meta(assetId).order||Date.now()});await save();render(); }
async function duplicateAsset(assetId) { const asset=allAssets.find(item=>item.id===assetId),source=store.sources.find(item=>item.id===asset?.sourceId);if(!asset||!source)return;const copy={...asset,id:uid(),name:`${asset.name} (copy)`};source.assets.push(copy);store.assetMeta[copy.id]=JSON.parse(JSON.stringify(meta(assetId)));store.assetMeta[copy.id].isDuplicate=true;store.assetMeta[copy.id].order=(meta(assetId).order||Date.now())-.01;store.collections.filter(gallery=>gallery.items.includes(assetId)).forEach(gallery=>{if(!gallery.items.includes(copy.id))gallery.items.push(copy.id);markManualItems(gallery,[copy.id]);});await save();await collectAssets();render(); }
async function reorder(moved, target, after=false) { return reorderLayout(`asset:${moved}`,`asset:${target}`,after); }
async function reorderLayout(moved,target,after=false) { const keys=$$('[data-layout-key]').map(node=>node.dataset.layoutKey); const oldIndex=keys.indexOf(moved), targetIndex=keys.indexOf(target); if(oldIndex<0||targetIndex<0)return; keys.splice(oldIndex,1); keys.splice(keys.indexOf(target)+(after?1:0),0,moved); const baseline=Date.now(); keys.forEach((key,index)=>{const [kind,id]=key.split(':');if(kind==='asset')meta(id).order=baseline-index;else {const group=activeGroups().find(item=>item.id===id);if(group)group.order=baseline-index;}}); clearDropMarkers(); await save(); renderCanvas(); }
function openLightbox(id) { lightboxAssets=visibleAssets(); lightboxIndex=lightboxAssets.findIndex(asset=>asset.id===id); if(lightboxIndex<0)return; renderLightbox(); $('#lightbox').classList.remove('hidden'); }
function syncNativeVideoSpeedCue(video) {
  if (!video || !window.VTTCue) return;
  const track = video._speedTrack ||= video.addTextTrack('captions', 'Playback speed', 'vi');
  while (track.cues?.length) track.removeCue(track.cues[0]);
  const cue = new VTTCue(0, 2147483647, `${video.playbackRate.toFixed(2)}×`);
  cue.line = 0; cue.position = 100; cue.align = 'end'; cue.size = 26;
  track.addCue(cue);
  // Captions are rendered by the native video surface, including its own
  // fullscreen mode. Keep the cue out of the normal Lightbox view.
  track.mode = document.fullscreenElement === video ? 'showing' : 'disabled';
  return track;
}
function showVideoSpeedFeedback(video) {
  const indicator = $('#videoSpeedIndicator'), track = syncNativeVideoSpeedCue(video);
  if (indicator) { indicator.textContent = `${video.playbackRate.toFixed(2)}×`; indicator.classList.add('is-visible'); }
  if (track && document.fullscreenElement === video) track.mode = 'showing';
  clearTimeout(videoSpeedFeedbackTimer);
  videoSpeedFeedbackTimer = setTimeout(() => {
    indicator?.classList.remove('is-visible');
    if (track) track.mode = 'disabled';
  }, 1000);
}
function renderLightbox() { const asset=lightboxAssets[lightboxIndex]; if(!asset)return; $('#lightboxIndex').textContent=`${lightboxIndex+1} / ${lightboxAssets.length}`; $('#lightboxName').textContent=asset.name; $('#lightboxMedia').innerHTML=asset.type==='image' ? `<img src="${mediaURL(asset)}" alt="${escapeHTML(asset.name)}">` : `<video src="${mediaURL(asset)}" controls autoplay></video><span id="videoSpeedIndicator" class="video-speed-indicator">1.00×</span>`; const video=$('#lightboxMedia video');if(video)syncNativeVideoSpeedCue(video); $('#previousAsset').disabled=lightboxIndex===0; $('#nextAsset').disabled=lightboxIndex===lightboxAssets.length-1; }
function moveLightbox(step) { const next=lightboxIndex+step; if(next<0||next>=lightboxAssets.length)return; lightboxIndex=next; renderLightbox(); }
function closeLightbox() { $('#lightboxMedia').innerHTML=''; $('#lightbox').classList.add('hidden'); lightboxAssets=[]; lightboxIndex=-1; }
function activeVideoPlayer() { return $('#lightbox').classList.contains('hidden') ? null : $('#lightboxMedia video'); }
function handleVideoSpeedShortcut(event) {
  if (!['NumpadAdd', 'NumpadSubtract', 'NumpadMultiply'].includes(event.code) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  const video = activeVideoPlayer();
  if (!video) return false;
  const current = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
  const speed = event.code === 'NumpadAdd' ? Math.min(4, current + .25) : event.code === 'NumpadSubtract' ? Math.max(.25, current - .25) : 1;
  event.preventDefault();
  video.playbackRate = speed;
  video.defaultPlaybackRate = speed;
  showVideoSpeedFeedback(video);
  return true;
}
function renderInspector() {
  const asset = allAssets.find(item => item.id === selectedId), gallery = currentCollection(), multiple=selectedIds.size>1;
  if(asset)$('#inspector').classList.remove('hidden');
  $('#inspectorOverline').textContent = gallery && !asset ? 'GALLERY' : multiple ? `${selectedIds.size} MEDIA · XEM TRƯỚC ẢNH CUỐI` : 'CHI TIẾT';
  $('#inspectorTitle').textContent = gallery && !asset ? 'Gallery details' : multiple ? `Đã chọn ${selectedIds.size} media` : 'Đối tượng đã chọn';
  $('#galleryInspector').classList.toggle('hidden', !(gallery && !asset));
  $('#inspectorEmpty').classList.toggle('hidden', !!asset || !!gallery); $('#inspectorBody').classList.toggle('hidden', !asset);
  if (gallery && !asset) return renderGalleryInspector(gallery);
  if (!asset) return;
  const item = meta(asset.id), parentSource=store.sources.find(source=>source.id===asset.sourceId); $('#detailName').textContent = asset.name; $('#detailPath').textContent = parentSource?.name||'Library'; $('#sourceFolderInfo').innerHTML = parentSource?`<strong>${escapeHTML(parentSource.name)}</strong><small>${escapeHTML(parentSource.path)}</small>`:'<span class="muted-small">No source folder</span>'; $('#previewWrap').innerHTML = asset.type === 'image' ? `<img src="${mediaURL(asset)}">` : `<video src="${mediaURL(asset)}" controls></video>`;
  $('#favoriteToggle').checked = !!item.favorite; pills('#tagPills',item.tags,'tags'); pills('#personPills',item.persons,'persons'); $('#assetNote').value = item.note || '';
  const memberships=store.collections.filter(collection=>collection.items.includes(asset.id)); $('#folderMembership').innerHTML=memberships.map(collection=>`<span class="pill"><span class="gallery-icon">▧</span>${escapeHTML(collection.name)}<button data-remove-folder="${collection.id}">×</button></span>`).join('') || '<span class="muted-small">Chưa thuộc Gallery nào</span>';
  const discardOrigin=store.collections.find(gallery=>gallery.id===discardOriginGalleryId);$('#discardOriginSection').classList.toggle('hidden',!discardOrigin);$('#discardOriginInfo').textContent=discardOrigin?discardOrigin.name:'';
  $('#removeFromCollection').classList.toggle('hidden', !currentCollection());
}
function renderGalleryInspector(gallery) {
  $('#inspector').classList.remove('hidden');
  $('#galleryNameInput').value = gallery.name || '';
  const autoTags = (selector, values, empty) => $(selector).innerHTML = values.length ? values.map(value => `<span class="pill">${escapeHTML(value)}</span>`).join('') : `<span class="muted-small">${empty}</span>`;
  autoTags('#galleryThemeTags', gallery.defaultTags || [], 'No Theme auto tags');
  autoTags('#galleryCharacterTags', gallery.defaultPersons || [], 'No Character auto tags');
  const sourceRows=(gallery.sourceIds||[]).map(id=>{const source=store.sources.find(item=>item.id===id);if(!source)return '';const count=(gallery.items||[]).filter(assetId=>{const asset=allAssets.find(item=>item.id===assetId);return asset?.sourceId===id&&!(gallery.discardedIds||[]).includes(assetId);}).length;return `<div class="gallery-source-row"><span><strong>${escapeHTML(source.name)}</strong><small>${escapeHTML(source.path)}</small></span><b>${count}</b><button type="button" title="Remove source folder" aria-label="Remove ${escapeHTML(source.name)}" data-remove-gallery-inspector-source="${source.id}">×</button></div>`;}).join('');$('#galleryMediaSources').innerHTML=sourceRows||'<span class="muted-small">No source folders. Use ＋ to add one.</span>';
  $('#saveGalleryName').onclick = async () => {
    const name = $('#galleryNameInput').value.trim();
    if (!name) return toast('Gallery needs a name');
    gallery.name = name;
    await save();
    renderSidebars();
    toast('Gallery updated');
  };
  $('#addGallerySource').onclick = () => addSourceToGallery(gallery);
  $$('[data-remove-gallery-inspector-source]').forEach(button=>button.onclick=()=>removeSourceFromGallery(gallery,button.dataset.removeGalleryInspectorSource));
  $$('[data-gallery-auto-kind]').forEach(button=>button.onclick=()=>openGalleryAutoTagPicker(gallery,button.dataset.galleryAutoKind));
}
function openGalleryAutoTagPicker(gallery, initialField='tags') {
  const fields={tags:{title:'Theme auto tags',definitions:store.tagDefinitions},persons:{title:'Character auto tags',definitions:store.personDefinitions}};
  openModal(`<h2>Gallery auto tags</h2><p>Choose from the existing tag groups. These tags are applied when media is added to this Gallery.</p><div class="property-tabs"><button data-gallery-tag-field="tags" class="${initialField==='tags'?'selected':''}">Theme</button><button data-gallery-tag-field="persons" class="${initialField==='persons'?'selected':''}">Character</button></div><div id="galleryAutoTagValues"></div><div class="modal-footer"><button class="secondary-button" data-close>Close</button></div>`);
  const renderValues=field=>{
    const config=fields[field],selected=field==='tags'?(gallery.defaultTags||[]):(gallery.defaultPersons||[]);
    $('#galleryAutoTagValues').innerHTML=config.definitions.length?config.definitions.map(definition=>`<button class="bulk-tag-value ${selected.includes(definition.name)?'selected':''}" data-gallery-auto-value="${escapeHTML(definition.name)}">${selected.includes(definition.name)?'✓ ':'＋ '}${escapeHTML(definition.name)}</button>`).join(''):'<p class="muted-small">No existing values in this tag group.</p>';
    $$('[data-gallery-auto-value]').forEach(button=>button.onclick=async()=>{const value=button.dataset.galleryAutoValue,key=field==='tags'?'defaultTags':'defaultPersons';gallery[key] ||= [];gallery[key]=gallery[key].includes(value)?gallery[key].filter(item=>item!==value):[...gallery[key],value];await save();renderValues(field);if(currentCollection()?.id===gallery.id)renderGalleryInspector(gallery);});
  };
  renderValues(initialField);
  $$('[data-gallery-tag-field]').forEach(button=>button.onclick=()=>{const field=button.dataset.galleryTagField;$$('[data-gallery-tag-field]').forEach(item=>item.classList.toggle('selected',item===button));renderValues(field);});
}
function pills(selector, values, field) { $(selector).innerHTML = values.map(value => `<span class="pill">${escapeHTML(value)}<button data-pill-field="${field}" data-pill-value="${escapeHTML(value)}">×</button></span>`).join(''); }
async function addValue(input, field) { const value = input.value.trim(),ids=selectedTargetIds(); if (!value || !ids.length) return; ids.forEach(id=>{const list=meta(id)[field];if(!list.some(item=>item.toLowerCase()===value.toLowerCase()))list.push(value);}); const definitions=field==='tags'?store.tagDefinitions:store.personDefinitions; if (!definitions.some(tag => tag.name.toLowerCase() === value.toLowerCase())) definitions.push({ name:value }); input.value=''; await save(); renderInspector(); }
async function removeValue(field,value) { selectedTargetIds().forEach(id=>{const data=meta(id);data[field]=data[field].filter(item=>item!==value);}); await save(); renderInspector(); }
async function addSource() {
  const folder = await window.vision.pickFolder(); if (!folder) return;
  let source=store.sources.find(item=>sameSourceFolder(item.path,folder));store.librarySourceIds ||= [];
  if(source){if(!store.librarySourceIds.includes(source.id))store.librarySourceIds.push(source.id);await save();render();return toast('Source đã được thêm vào Main Gallery');}
  source={id:uid(),path:folder,name:sourceFolderName(folder),assets:[],indexing:true};store.sources.push(source);store.librarySourceIds.push(source.id);await syncSourceWatchers();await save();render();toast('Đang index source nền…');refreshSourcesInBackground([source.id]);
}
async function refreshSources(sourceIds) { const sources=Array.isArray(sourceIds)?store.sources.filter(source=>sourceIds.includes(source.id)):store.sources;if(sourceRefreshInProgress)return toast('Đang quét media, vui lòng chờ…');if(!sources.length)return toast('Gallery này chưa có source folder');sourceRefreshInProgress=true;try{toast('Đang quét lại media…');let moved=false;for(const source of sources)moved=(await scanSource(source))||moved;await collectAssets();syncGallerySourceAssets();if(moved)await syncSourceWatchers();await save();render();toast('Media đã được cập nhật');}finally{sourceRefreshInProgress=false;if(pendingSourcePaths.size){clearTimeout(sourceRefreshTimer);sourceRefreshTimer=setTimeout(flushSourceRefresh,0);}} }
function normalizedMediaPath(value) { return String(value||'').replace(/[\\/]+$/,'').toLowerCase(); }
function mediaParentPath(value) { const path=String(value||'').replace(/[\\/]+$/,'');const index=Math.max(path.lastIndexOf('\\'),path.lastIndexOf('/'));return index>0?path.slice(0,index):path; }
function isExtensionSource(source) { return source?.id==='allsight-web-imports'||/^(web extention|web imports?)$/i.test(source?.name||''); }
function mediaLocationSyncCandidates() {
  const candidates=new Map();
  store.collections.forEach(gallery=>{
    const targetId=(gallery.sourceIds||[]).length===1?gallery.sourceIds[0]:null,target=store.sources.find(source=>source.id===targetId);
    if(!target||(target.assets||[]).some(asset=>asset.vault))return;
    const sourceParent=normalizedMediaPath(mediaParentPath(target.path));
    (gallery.items||[]).filter(id=>!(gallery.discardedIds||[]).includes(id)).forEach(assetId=>{
      const asset=allAssets.find(item=>item.id===assetId),origin=store.sources.find(source=>source.id===asset?.sourceId);
      if(!asset?.path||asset.vault||normalizedMediaPath(mediaParentPath(asset.path))===normalizedMediaPath(target.path))return;
      if(normalizedMediaPath(mediaParentPath(asset.path))!==sourceParent&&!isExtensionSource(origin))return;
      const candidate={assetId:asset.id,assetPath:asset.path,targetSourceId:target.id,galleryName:gallery.name,targetName:target.name};
      const matches=candidates.get(asset.path)||[];if(!matches.some(item=>item.targetSourceId===target.id))matches.push(candidate);candidates.set(asset.path,matches);
    });
  });
  return [...candidates.values()].filter(matches=>matches.length===1).map(matches=>matches[0]);
}
function remapAssetId(oldId,newId) {
  if(!oldId||!newId||oldId===newId)return;
  if(store.assetMeta[oldId]){store.assetMeta[newId]||=store.assetMeta[oldId];delete store.assetMeta[oldId];}
  [...store.collections,...(store.discardedGalleries||[])].forEach(gallery=>{gallery.items=[...new Set((gallery.items||[]).map(id=>id===oldId?newId:id))];gallery.manualItemIds=[...new Set((gallery.manualItemIds||[]).map(id=>id===oldId?newId:id))];gallery.discardedIds=[...new Set((gallery.discardedIds||[]).map(id=>id===oldId?newId:id))];gallery.excludedItemIds=[...new Set((gallery.excludedItemIds||[]).map(id=>id===oldId?newId:id))];gallery.groups=(gallery.groups||[]).map(group=>({...group,assets:[...new Set((group.assets||[]).map(id=>id===oldId?newId:id))],coverId:group.coverId===oldId?newId:group.coverId}));if(gallery.coverId===oldId)gallery.coverId=newId;});
  store.libraryGroups=(store.libraryGroups||[]).map(group=>({...group,assets:[...new Set((group.assets||[]).map(id=>id===oldId?newId:id))],coverId:group.coverId===oldId?newId:group.coverId}));
  if(selectedId===oldId)selectedId=newId;if(selectedIds.has(oldId)){selectedIds.delete(oldId);selectedIds.add(newId);}
}
function openMediaLocationSync() {
  const candidates=mediaLocationSyncCandidates();
  if(!candidates.length)return toast('Không có media phù hợp để đồng bộ vị trí');
  const rows=candidates.slice(0,12).map(item=>`<div class="gallery-source-row"><span>${escapeHTML(item.galleryName)} · ${escapeHTML(item.targetName)}</span><b>${escapeHTML(item.assetPath.split(/\\|\//).pop())}</b></div>`).join('');
  openModal(`<h2>Sync media location</h2><p>${candidates.length} file sẽ được di chuyển vào source duy nhất của Gallery tương ứng. Chỉ gồm file ở folder cha của source hoặc Web Extension. File trùng tên ở đích sẽ được bỏ qua.</p><div class="gallery-media-sources">${rows}${candidates.length>12?`<span class="muted-small">và ${candidates.length-12} file khác</span>`:''}</div><div class="modal-footer"><button class="secondary-button" data-close>Hủy</button><button id="confirmMediaLocationSync" class="primary-button">Di chuyển ${candidates.length} file</button></div>`);
  $('#confirmMediaLocationSync').onclick=async()=>{const button=$('#confirmMediaLocationSync');button.disabled=true;button.textContent='Đang di chuyển…';try{const result=await window.vision.syncMediaLocations(candidates);if(result.moved.length){await Promise.all(store.sources.map(scanSource));await collectAssets();result.moved.forEach(entry=>{const moved=allAssets.find(asset=>normalizedMediaPath(asset.path)===normalizedMediaPath(entry.to));if(moved)remapAssetId(entry.assetId,moved.id);});syncGallerySourceAssets();await save();render();}closeModal();toast(result.moved.length?`Đã di chuyển ${result.moved.length} media${result.skipped.length?`; bỏ qua ${result.skipped.length}`:''}`:'Không thể di chuyển media nào');}catch{button.disabled=false;button.textContent='Di chuyển thất bại';toast('Không thể đồng bộ vị trí media');}};
}
async function removeSource(id) { const source=store.sources.find(item=>item.id===id); if (!source || !confirm(`Xóa nguồn “${source.name}” khỏi Master Vision? File gốc vẫn được giữ nguyên.`)) return; store.sources=store.sources.filter(item=>item.id!==id);await window.vision.removeCachedSource(id);store.librarySourceIds=(store.librarySourceIds||[]).filter(sourceId=>sourceId!==id);store.collections.forEach(collection=>{collection.items=collection.items.filter(assetId=>allAssets.some(asset=>asset.id===assetId && asset.sourceId!==id));collection.sourceIds=(collection.sourceIds||[]).filter(sourceId=>sourceId!==id);}); if(currentView===`source:${id}`) currentView='all'; await collectAssets(); await syncSourceWatchers(); await save(); render(); }
async function addSourceToGallery(gallery) {
  const folder = await window.vision.pickFolder();
  if (!folder) return;
  let source = store.sources.find(item => sameSourceFolder(item.path, folder));
  if (!source) {
    source = { id: uid(), path: folder, name: sourceFolderName(folder), assets: [], indexing: true };
    store.sources.push(source);
    await syncSourceWatchers();
    refreshSourcesInBackground([source.id]);
  }
  gallery.sourceIds ||= [];
  if (gallery.sourceIds.includes(source.id)) return toast('Source này đã có trong Gallery');
  gallery.sourceIds.push(source.id);
  syncGallerySourceAssets();
  await save();
  render();
  toast(`Đã thêm source “${source.name}”`);
}
async function removeSourceFromGallery(gallery, sourceId) {
  const source = store.sources.find(item => item.id === sourceId);
  if (!source || !gallery.sourceIds?.includes(sourceId)) return;
  if (!confirmAction(`Gỡ source “${source.name}” khỏi Gallery “${gallery.name}”? Media từ source này sẽ không còn nằm trong Gallery.`)) return;
  const removedAssetIds = new Set(allAssets.filter(asset => asset.sourceId === sourceId).map(asset => asset.id));
  gallery.sourceIds = gallery.sourceIds.filter(id => id !== sourceId);
  gallery.items = (gallery.items || []).filter(id => !removedAssetIds.has(id));
  gallery.manualItemIds = (gallery.manualItemIds || []).filter(id => !removedAssetIds.has(id));
  gallery.discardedIds = (gallery.discardedIds || []).filter(id => !removedAssetIds.has(id));
  gallery.groups = (gallery.groups || []).map(group => ({ ...group, assets: group.assets.filter(id => !removedAssetIds.has(id)) })).filter(group => group.assets.length > 1);
  if (removedAssetIds.has(gallery.coverId)) delete gallery.coverId;
  syncGallerySourceAssets();
  await save();
  render();
  toast(`Đã gỡ source “${source.name}”`);
}
function openCollectionModal(collection) {
  const title = collection ? 'Edit Gallery' : 'Create Gallery',data=collection || {name:'',note:'',defaultTags:[],defaultPersons:[],sourceIds:[],color:colors[0]},selectedSourceIds=new Set(data.sourceIds||[]);
  openModal(`<h2>${title}</h2><p>A Gallery organizes media without moving the original files on your computer.</p><label>Gallery name</label><input id="collectionName" value="${escapeHTML(data.name)}" placeholder="Example: Summer moodboard"><label>Notes</label><textarea id="collectionNote" placeholder="Description or ideas">${escapeHTML(data.note)}</textarea><label>Media sources <small>(multiple folders allowed)</small></label><p class="muted-small">Add every folder whose media should appear in this Gallery.</p><div id="collectionSources" class="collection-source-list"></div><button id="addCollectionSource" class="secondary-button">＋ Add another source folder</button><label>Theme auto tag <small>(comma separated)</small></label><input id="collectionTags" value="${escapeHTML(data.defaultTags.join(', '))}" placeholder="portrait, light, campaign"><label>Character auto tag <small>(comma separated)</small></label><input id="collectionPersons" value="${escapeHTML((data.defaultPersons||[]).join(', '))}" placeholder="person, character"><label>Màu nhận diện</label><div class="color-row">${colors.map(color=>`<button class="color-pick ${data.color===color?'selected':''}" data-color="${color}" style="background:${color}"></button>`).join('')}</div><div class="modal-footer"><button class="secondary-button" data-close>Hủy</button><button class="primary-button" id="saveCollection">${collection?'Save changes':'Create Gallery'}</button></div>`);
  const renderSources=()=>{$('#collectionSources').innerHTML=selectedSourceIds.size?[...selectedSourceIds].map(id=>{const source=store.sources.find(item=>item.id===id);return source?`<div class="folder-choice"><span>${escapeHTML(source.name)}</span><small>${(source.assets||[]).length} media</small><button type="button" aria-label="Remove ${escapeHTML(source.name)}" title="Remove source folder" data-remove-gallery-source="${source.id}">×</button></div>`:'';}).join(''):'<span class="muted-small">No source folders selected. Add one or more folders.</span>';$$('[data-remove-gallery-source]').forEach(button=>button.onclick=()=>{selectedSourceIds.delete(button.dataset.removeGallerySource);renderSources();});};
  renderSources();
  $('#addCollectionSource').onclick=async()=>{const folder=await window.vision.pickFolder();if(!folder)return;let source=store.sources.find(item=>sameSourceFolder(item.path,folder));if(!source){source={id:uid(),path:folder,name:sourceFolderName(folder),assets:[],indexing:true};store.sources.push(source);await syncSourceWatchers();refreshSourcesInBackground([source.id]);}selectedSourceIds.add(source.id);renderSources();};
  let picked=data.color; $$('.color-pick').forEach(button=>button.addEventListener('click',()=>{$$('.color-pick.selected')?.classList.remove('selected');button.classList.add('selected');picked=button.dataset.color;}));
  $('#saveCollection').addEventListener('click',async()=>{const sourceIds=[...selectedSourceIds];let name=$('#collectionName').value.trim();if(!name)name=sourceIds.length===1?store.sources.find(source=>source.id===sourceIds[0])?.name||'Untitled Gallery':'Untitled Gallery';const details={name,note:$('#collectionNote').value.trim(),defaultTags:$('#collectionTags').value.split(',').map(x=>x.trim()).filter(Boolean),defaultPersons:$('#collectionPersons').value.split(',').map(x=>x.trim()).filter(Boolean),sourceIds,color:picked};if(collection){const removed=new Set((collection.sourceIds||[]).filter(id=>!sourceIds.includes(id))),removedAssets=new Set(allAssets.filter(asset=>removed.has(asset.sourceId)).map(asset=>asset.id));if(removedAssets.size){collection.items=(collection.items||[]).filter(id=>!removedAssets.has(id));collection.manualItemIds=(collection.manualItemIds||[]).filter(id=>!removedAssets.has(id));collection.discardedIds=(collection.discardedIds||[]).filter(id=>!removedAssets.has(id));collection.groups=(collection.groups||[]).map(group=>({...group,assets:group.assets.filter(id=>!removedAssets.has(id))})).filter(group=>group.assets.length>1);if(removedAssets.has(collection.coverId))delete collection.coverId;}Object.assign(collection,details);}else{const fresh={id:uid(),items:[],groups:[],manualItemIds:[],discardedIds:[],excludedItemIds:[],generalTagGroupIds:tagGroups().map(group=>group.id),exclusiveTagGroups:[],autoTagGroups:{},...details};store.collections.push(fresh);currentView=`collection:${fresh.id}`;}syncGallerySourceAssets();await save();closeModal();render();});
}
function markManualItems(collection,ids) { collection.manualItemIds ||= [];ids.forEach(id=>{const asset=allAssets.find(item=>item.id===id);if(asset&&!(collection.sourceIds||[]).includes(asset.sourceId)&&!collection.manualItemIds.includes(id))collection.manualItemIds.push(id);}); }
function addSelectedToCollection() { if (!selectedId) return toast('Hãy chọn một media trước'); if (!store.collections.length) return openCollectionModal(); const choices=store.collections.map(c=>`<option value="${c.id}">${escapeHTML(c.name)}</option>`).join(''); openModal(`<h2>Add to Gallery</h2><p>Gallery auto tags will be assigned to this media.</p><select id="targetCollection">${choices}</select><div class="modal-footer"><button class="secondary-button" data-close>Hủy</button><button class="primary-button" id="confirmAdd">Add</button></div>`); $('#confirmAdd').addEventListener('click',async()=>{const c=store.collections.find(x=>x.id===$('#targetCollection').value);if(!c.items.includes(selectedId))c.items.push(selectedId);markManualItems(c,[selectedId]);c.defaultTags.forEach(tag=>{if(!meta(selectedId).tags.includes(tag))meta(selectedId).tags.push(tag)});(c.defaultPersons||[]).forEach(tag=>{if(!meta(selectedId).persons.includes(tag))meta(selectedId).persons.push(tag)});await save();closeModal();toast('Added to Gallery');render();}); }
function openBulkFolderPicker() { const ids=[...selectedIds];if(!ids.length)return;if(!store.collections.length)return openCollectionModal();openModal(`<h2>Add ${ids.length} images to Gallery</h2><select id="bulkTargetFolder">${store.collections.map(collection=>`<option value="${collection.id}">${escapeHTML(collection.name)}</option>`).join('')}</select><div class="modal-footer"><button data-close class="secondary-button">Hủy</button><button id="bulkFolderSave" class="primary-button">Add</button></div>`);$('#bulkFolderSave').onclick=async()=>{const collection=store.collections.find(item=>item.id===$('#bulkTargetFolder').value);ids.forEach(id=>{if(!collection.items.includes(id))collection.items.push(id);collection.defaultTags.forEach(tag=>{if(!meta(id).tags.includes(tag))meta(id).tags.push(tag);});(collection.defaultPersons||[]).forEach(tag=>{if(!meta(id).persons.includes(tag))meta(id).persons.push(tag);});});markManualItems(collection,ids);const group=groupOf(ids[0]);if(group&&ids.every(id=>group.assets.includes(id))&&!collection.groups.some(item=>item.id===group.id))collection.groups.push({...group,assets:[...ids]});await save();closeModal();render();}; }
async function bulkCreateGroup() { const ids=[...selectedIds];if(!ids.length)return;const groups=activeGroups();if(!confirmAction(`Tạo nhóm với ${ids.length} ảnh đã chọn?`))return;groups.push({id:uid(),title:'',assets:ids,order:Math.max(...ids.map(id=>meta(id).order||0))});await save();render(); }
async function discardAssets(ids) { const galleries=currentCollection()?[currentCollection()]:store.collections.filter(gallery=>!gallery.locked);ids.forEach(id=>galleries.filter(gallery=>gallery.items.includes(id)).forEach(gallery=>{gallery.discardedIds ||= [];if(!gallery.discardedIds.includes(id))gallery.discardedIds.push(id);gallery.groups=(gallery.groups||[]).map(group=>({...group,assets:group.assets.filter(assetId=>assetId!==id)})).filter(group=>group.assets.length>1);}));await save();selectedId=null;selectedIds.clear();render(); }
async function removeSelectedFromGroup() { const ids=[...selectedIds],group=ids.length?groupOf(ids[0]):null;if(!group||!ids.every(id=>group.assets.includes(id)))return;if(!confirmAction(`Remove ${ids.length} image(s) from this group?`))return;group.assets=group.assets.filter(id=>!ids.includes(id));dissolveSingletonGroups();ids.forEach((id,index)=>meta(id).order=(group.order||Date.now())-(index*.01));await save();render(); }
function openBulkTagPicker() { const ids=[...selectedIds];if(!ids.length)return;openModal(`<h2>Thêm tag cho ${ids.length} ảnh</h2><div class="property-tabs"><button data-bulk-tag-kind="tags" class="selected">Theme</button><button data-bulk-tag-kind="persons">Character</button></div><div id="bulkTagValues"></div><div class="modal-footer"><button data-close class="secondary-button">Đóng</button></div>`);const renderValues=field=>{$('#bulkTagValues').innerHTML=(field==='tags'?store.tagDefinitions:store.personDefinitions).map(definition=>`<button class="bulk-tag-value" data-bulk-tag-value="${escapeHTML(definition.name)}">＋ ${escapeHTML(definition.name)}</button>`).join('')||'<p class="muted-small">Chưa có tag</p>';$$('[data-bulk-tag-value]').forEach(button=>button.onclick=async()=>{ids.forEach(id=>{if(!meta(id)[field].includes(button.dataset.bulkTagValue))meta(id)[field].push(button.dataset.bulkTagValue);});await save();closeModal();renderInspector();});};renderValues('tags');$$('[data-bulk-tag-kind]').forEach(button=>button.onclick=()=>{ $$('[data-bulk-tag-kind]').forEach(item=>item.classList.toggle('selected',item===button));renderValues(button.dataset.bulkTagKind);}); }
async function dissolveSelectedGroup() { const ids=[...selectedIds],group=ids.length&&groupOf(ids[0]);if(!group||!ids.every(id=>group.assets.includes(id)))return;if(!confirmAction('Rã nhóm này?'))return;activeGroups().splice(activeGroups().indexOf(group),1);await save();render(); }
function removeCollectionTags(assetId, collection) { const item=meta(assetId); const placedElsewhere=store.collections.some(other=>other.id!==collection.id && other.items.includes(assetId)); if (!placedElsewhere) { item.tags=item.tags.filter(tag=>!collection.defaultTags.includes(tag)); item.persons=item.persons.filter(tag=>!(collection.defaultPersons||[]).includes(tag)); } }
async function removeFromCollection() {const collection=currentCollection(),ids=selectedTargetIds();if(!collection||!ids.length)return;collection.excludedItemIds ||= [];ids.forEach(id=>{if(isSourceOwnedByGallery(collection,id)&&!collection.excludedItemIds.includes(id))collection.excludedItemIds.push(id);removeGalleryAssetReferences(collection,id);removeCollectionTags(id,collection);});await save();selectedId=null;selectedIds.clear();toast('Đã exclude khỏi Gallery');render();}
function isSourceOwnedByGallery(collection, assetId) { const asset=allAssets.find(item=>item.id===assetId);return !!asset&&collection.sourceIds?.includes(asset.sourceId); }
function removeGalleryAssetReferences(collection, assetId) { collection.items=(collection.items||[]).filter(id=>id!==assetId);collection.manualItemIds=(collection.manualItemIds||[]).filter(id=>id!==assetId);collection.discardedIds=(collection.discardedIds||[]).filter(id=>id!==assetId);collection.groups=(collection.groups||[]).map(group=>({...group,assets:group.assets.filter(id=>id!==assetId)})).filter(group=>group.assets.length>1);if(collection.coverId===assetId)delete collection.coverId; }
async function excludeFromGallery(collectionId, ids=selectedTargetIds()) { const collection=store.collections.find(item=>item.id===collectionId);if(!collection||!ids.length)return;collection.excludedItemIds ||= [];ids.forEach(id=>{if(!collection.excludedItemIds.includes(id))collection.excludedItemIds.push(id);removeGalleryAssetReferences(collection,id);});await save();if(currentCollection()?.id===collection.id){selectedId=null;selectedIds.clear();render();}else{renderInspector();renderSidebars();} }
async function toggleAssetFolder(collectionId,checked) { const collection=store.collections.find(item=>item.id===collectionId),ids=selectedTargetIds();if(!collection||!ids.length)return;if(!checked&&ids.some(id=>isSourceOwnedByGallery(collection,id)))return excludeFromGallery(collectionId,ids);collection.excludedItemIds ||= [];ids.forEach(id=>{if(checked){collection.excludedItemIds=collection.excludedItemIds.filter(item=>item!==id);if(!collection.items.includes(id))collection.items.push(id);collection.defaultTags.forEach(tag=>{if(!meta(id).tags.includes(tag))meta(id).tags.push(tag);});(collection.defaultPersons||[]).forEach(tag=>{if(!meta(id).persons.includes(tag))meta(id).persons.push(tag);});}else{removeGalleryAssetReferences(collection,id);removeCollectionTags(id,collection);}});if(checked)markManualItems(collection,ids);await save();renderInspector();renderSidebars(); }
function openContextMenu(event,assetId) {
  const menu=$('#contextMenu'),asset=allAssets.find(item=>item.id===assetId),group=groupOf(assetId),collection=currentCollection(),ids=selectedTargetIds();
  if(!asset)return;
  menu.style.left=`${Math.min(event.clientX,window.innerWidth-245)}px`;menu.style.top=`${Math.min(event.clientY,window.innerHeight-250)}px`;menu.classList.remove('hidden');
  if(ids.length>=2) {
    const sharedGroup=groupOf(ids[0]),allInSharedGroup=sharedGroup&&ids.every(id=>sharedGroup.assets.includes(id)),allUngrouped=ids.every(id=>!groupOf(id));
    menu.innerHTML=`${allInSharedGroup||allUngrouped?`<button data-context-bulk-group>${allInSharedGroup?'Remove from group':'Create group'}</button>`:''}<button data-context-bulk-hide>Hide image</button><button data-context-bulk-gallery>Add to Gallery</button><button data-context-bulk-tag>Add tag</button>`;
    menu.querySelector('[data-context-bulk-group]')?.addEventListener('click',()=>{closeContextMenu();if(allInSharedGroup)removeSelectedFromGroup();else bulkCreateGroup();});
    menu.querySelector('[data-context-bulk-hide]').onclick=async()=>{if(!confirmAction(`Move ${ids.length} selected images to Discard Pile?`))return;closeContextMenu();await discardAssets(ids);};
    menu.querySelector('[data-context-bulk-gallery]').onclick=()=>{closeContextMenu();openBulkFolderPicker();};
    menu.querySelector('[data-context-bulk-tag]').onclick=()=>{closeContextMenu();openBulkTagPicker();};
    return;
  }
  const galleryItems=store.collections.map(gallery=>{const excluded=gallery.excludedItemIds?.includes(assetId),included=gallery.items.includes(assetId);return `<button data-context-gallery="${gallery.id}">${included?'✓ ':excluded?'↩ ':'＋ '}${excluded?'Khôi phục vào ':''}${escapeHTML(gallery.name)}</button>`;}).join('')||'<span class="context-empty">Create a Gallery first</span>';
  const copyTagGroups=tagGroups().map(tagGroup=>`<button data-context-copy-tag-group="${tagGroup.id}">Copy ${escapeHTML(tagGroup.name)}</button>`).join('');
  const paste=copiedTagGroup?'<button data-context-paste>Paste tags</button>':'';
  menu.innerHTML=`<button data-context-open>Open</button><button data-context-open-default ${asset.vault?'disabled':''}>Open with default app</button><button data-context-show-folder>Open in Folder</button><button data-context-copy ${asset.type!=='image'?'disabled':''}>Copy image to clipboard</button>${copyTagGroups}${paste}<div class="context-divider"></div>${group?'<button data-context-remove-group>Remove image from group</button>':''}<button data-context-duplicate>Duplicate image</button><button data-context-hide>Hide image</button>${collection&&isSourceOwnedByGallery(collection,assetId)?'<button data-context-exclude-current>Exclude from this Gallery</button>':''}${collection?'<button data-context-cover>Set as Gallery cover</button>':''}<div class="context-divider"></div><div class="context-label">Add to Gallery</div>${galleryItems}`;
  menu.querySelector('[data-context-open]').onclick=()=>{closeContextMenu();openLightbox(assetId);};menu.querySelector('[data-context-open-default]')?.addEventListener('click',async()=>{const opened=await window.vision.openWithDefaultApp(asset);closeContextMenu();if(!opened)toast('Không thể mở bằng ứng dụng mặc định');});menu.querySelector('[data-context-show-folder]').onclick=()=>{window.vision.showInFolder(asset);closeContextMenu();};menu.querySelector('[data-context-copy]')?.addEventListener('click',async()=>{if(asset.type!=='image')return;const ok=await window.vision.copyImage(asset);closeContextMenu();toast(ok?'Copied image to clipboard':'Unable to copy image');});
  $$('[data-context-copy-tag-group]').forEach(button=>button.onclick=()=>{const tagGroup=tagGroups().find(item=>item.id===button.dataset.contextCopyTagGroup);if(!tagGroup)return;copiedTagGroup={id:tagGroup.id,name:tagGroup.name,values:[...tagGroupValues(meta(assetId),tagGroup)]};closeContextMenu();toast(`Đã copy ${tagGroup.name}`);});
  menu.querySelector('[data-context-paste]')?.addEventListener('click',async()=>{const tagGroup=tagGroups().find(item=>item.id===copiedTagGroup?.id);if(!tagGroup)return;const values=tagGroupValues(meta(assetId),tagGroup);values.splice(0,values.length,...new Set([...values,...copiedTagGroup.values]));await save();closeContextMenu();renderInspector();});
  menu.querySelector('[data-context-remove-group]')?.addEventListener('click',()=>{closeContextMenu();removeFromGroupAfterCurrent(assetId);});menu.querySelector('[data-context-duplicate]').onclick=()=>{closeContextMenu();duplicateAsset(assetId);};menu.querySelector('[data-context-hide]').onclick=async()=>{if(!confirmAction('Move image to Discard Pile?'))return;closeContextMenu();await discardAssets([assetId]);};menu.querySelector('[data-context-exclude-current]')?.addEventListener('click',()=>{closeContextMenu();excludeFromGallery(collection.id,[assetId]);});menu.querySelector('[data-context-cover]')?.addEventListener('click',async()=>{collection.coverId=assetId;await save();closeContextMenu();renderSidebars();});$$('[data-context-gallery]').forEach(button=>button.onclick=async()=>{const gallery=store.collections.find(item=>item.id===button.dataset.contextGallery);if(!gallery)return;selectedId=assetId;selectedIds=new Set([assetId]);await toggleAssetFolder(gallery.id,gallery.excludedItemIds?.includes(assetId)||!gallery.items.includes(assetId));closeContextMenu();});
}
function closeContextMenu() { $('#contextMenu').classList.add('hidden'); }
async function importFolderIntoCollection(collection) { const folder=await window.vision.pickFolder();if(!folder)return;let source=store.sources.find(item=>sameSourceFolder(item.path,folder));if(!source){source={id:uid(),path:folder,name:sourceFolderName(folder),assets:[],indexing:true};store.sources.push(source);await syncSourceWatchers();refreshSourcesInBackground([source.id]);}collection.sourceIds ||= [];if(!collection.sourceIds.includes(source.id))collection.sourceIds.push(source.id);syncGallerySourceAssets();await save();render(); }
function openGalleryTagCopyPicker(collection) { const groups=managedTagGroups(collection);openModal(`<h2>Copy Gallery tags</h2><p>Chọn tag group cần copy.</p><div class="gallery-exclude-list">${groups.map(group=>`<button class="gallery-tag-copy-choice" data-copy-gallery-tag-group="${group.id}">${escapeHTML(group.name)} <small>${galleryAutoTagValues(collection,group).length} tags</small></button>`).join('')||'<span class="muted-small">Gallery chưa quản lý tag group nào.</span>'}</div><div class="modal-footer"><button data-close class="secondary-button">Hủy</button></div>`);$$('[data-copy-gallery-tag-group]').forEach(button=>button.onclick=()=>{const group=groups.find(item=>item.id===button.dataset.copyGalleryTagGroup);if(!group)return;copiedGalleryTagGroup={id:group.id,name:group.name,values:[...galleryAutoTagValues(collection,group)]};closeModal();toast(`Đã copy ${group.name}`);}); }
async function pasteGalleryTags(collection) { const copied=copiedGalleryTagGroup,group=managedTagGroups(collection).find(item=>item.id===copied?.id);if(!copied||!group)return toast('Gallery này chưa quản lý tag group đã copy');const values=galleryAutoTagValues(collection,group);values.splice(0,values.length,...new Set([...values,...copied.values]));(collection.items||[]).forEach(assetId=>applyGalleryAutoTags(collection,assetId));await save();toast(`Đã paste ${copied.name}`); }
function openExclusiveTagManager(collection) { const render=()=>{const groups=collection.exclusiveTagGroups||[];openModal(`<h2>Exclusive tag groups</h2><p>Chỉ Gallery “${escapeHTML(collection.name)}” quản lý các group này.</p><div class="gallery-exclude-list">${groups.map(group=>`<div class="exclusive-tag-row"><label><input type="checkbox" data-exclusive-toggle="${group.id}" ${group.enabled!==false?'checked':''}> ${escapeHTML(group.name)}</label><small>${(group.values||[]).map(value=>escapeHTML(value.name||value)).join(', ')||'No tags'}</small><button data-exclusive-delete="${group.id}">×</button></div>`).join('')||'<span class="muted-small">Chưa có Exclusive tag group.</span>'}</div><div class="new-tag-row"><input id="exclusiveGroupName" placeholder="Tên tag group"><input id="exclusiveGroupValues" placeholder="tag 1, tag 2"><button id="createExclusiveTagGroup" class="primary-button">Thêm</button></div><div class="modal-footer"><button data-close class="secondary-button">Đóng</button></div>`);$('[data-exclusive-toggle]')&&$$('[data-exclusive-toggle]').forEach(input=>input.onchange=async()=>{const group=groups.find(item=>item.id===input.dataset.exclusiveToggle);if(group){group.enabled=input.checked;await save();}});$$('[data-exclusive-delete]').forEach(button=>button.onclick=async()=>{collection.exclusiveTagGroups=groups.filter(group=>group.id!==button.dataset.exclusiveDelete);await save();render();});$('#createExclusiveTagGroup').onclick=async()=>{const name=$('#exclusiveGroupName').value.trim(),values=$('#exclusiveGroupValues').value.split(',').map(value=>value.trim()).filter(Boolean);if(!name)return;collection.exclusiveTagGroups.push({id:uid(),name,values:values.map(name=>({name})),enabled:true});await save();render();};};render(); }
function openExclusiveTagExport(collection) { const groups=(collection.exclusiveTagGroups||[]).filter(group=>group.enabled!==false);openModal(`<h2>Export Exclusive Tags</h2><p>Chọn một hoặc nhiều tag group để export.</p><div class="gallery-exclude-list">${groups.map(group=>`<label class="gallery-exclude-row"><input type="checkbox" data-export-exclusive="${group.id}"><span>${escapeHTML(group.name)}</span><small>${(group.values||[]).length} tags</small></label>`).join('')||'<span class="muted-small">Gallery chưa có Exclusive tag group.</span>'}</div><div class="modal-footer"><button data-close class="secondary-button">Hủy</button><button id="saveExclusiveTagExport" class="primary-button">Export</button></div>`);$('#saveExclusiveTagExport').onclick=()=>{const ids=$$('[data-export-exclusive]:checked').map(input=>input.dataset.exportExclusive);exportedExclusiveTagGroups=groups.filter(group=>ids.includes(group.id)).map(group=>JSON.parse(JSON.stringify(group)));closeModal();toast(`Đã export ${exportedExclusiveTagGroups.length} Exclusive tag group`);}; }
async function importExclusiveTagGroups(collection) { if(!exportedExclusiveTagGroups.length)return;collection.exclusiveTagGroups ||= [];exportedExclusiveTagGroups.forEach(source=>{const existing=collection.exclusiveTagGroups.find(group=>group.name.toLowerCase()===source.name.toLowerCase());if(existing){existing.values=[...new Map([...(existing.values||[]),...(source.values||[])].map(value=>[(value.name||value).toLowerCase(),value])).values()];}else collection.exclusiveTagGroups.push({...JSON.parse(JSON.stringify(source)),id:uid()});});await save();toast('Đã import Exclusive Tags'); }
function openGalleryContextMenu(event, galleryIds) { const ids=[...new Set(galleryIds)];if(ids.length>1){const shared=galleryGroupOf(ids[0]),sameGroup=shared&&ids.every(id=>shared.galleries.includes(id)),menu=$('#contextMenu');menu.innerHTML=`<button data-gallery-group-action>${sameGroup?'Remove from group':'Tạo group'}</button>`;menu.style.left=`${Math.min(event.clientX,window.innerWidth-245)}px`;menu.style.top=`${Math.min(event.clientY,window.innerHeight-180)}px`;menu.classList.remove('hidden');menu.querySelector('[data-gallery-group-action]').onclick=async()=>{closeContextMenu();if(sameGroup){shared.galleries=shared.galleries.filter(id=>!ids.includes(id));dissolveSmallGalleryGroups();await save();render();}else await createGalleryGroup(ids);};return;}const id=ids[0],collection=store.collections.find(item=>item.id===id);if(!collection)return;openFolderContextMenu(event,id);const menu=$('#contextMenu'),anchor=menu.querySelector('.context-divider')||null,add=(label,action)=>{const button=document.createElement('button');button.textContent=label;button.onclick=action;menu.insertBefore(button,anchor);};add('Copy Tags',()=>{closeContextMenu();openGalleryTagCopyPicker(collection);});if(copiedGalleryTagGroup)add('Paste tags',()=>{closeContextMenu();pasteGalleryTags(collection);});add('Manage Exclusive Tags',()=>{closeContextMenu();openExclusiveTagManager(collection);});add('Export Exclusive Tags',()=>{closeContextMenu();openExclusiveTagExport(collection);});if(exportedExclusiveTagGroups.length)add('Import Exclusive Tags',()=>{closeContextMenu();importExclusiveTagGroups(collection);});const group=galleryGroupOf(id);if(group)add('Remove from group',()=>{closeContextMenu();removeGalleryFromGroup(id);});}
function openFolderContextMenu(event,collectionId) {
  const collection=store.collections.find(item=>item.id===collectionId),menu=$('#contextMenu');
  if(!collection)return;
  const temporarilyUnlocked=collection.locked&&unlockedGalleryIds.has(collection.id);
  const lockControls=collection.locked
    ? temporarilyUnlocked?'<button data-folder-lock-now>Lock now</button><button data-folder-unlock-permanently>Gỡ khóa vĩnh viễn</button>':'<button data-folder-unlock>Unlock Gallery</button>'
    :'<button data-folder-lock>Lock Gallery</button>';
  menu.innerHTML=`<button data-folder-rename>Rename Gallery</button><button data-folder-autotag>Auto tag</button>${lockControls}<button data-folder-import>Import images from folder</button><button data-folder-import-personal>Import from Gallery</button><div class="context-divider"></div><button class="context-danger" data-folder-delete>Delete Gallery</button>`;
  menu.style.left=`${Math.min(event.clientX,window.innerWidth-245)}px`;menu.style.top=`${Math.min(event.clientY,window.innerHeight-290)}px`;menu.classList.remove('hidden');
  menu.querySelector('[data-folder-rename]').onclick=()=>{closeContextMenu();openCollectionModal(collection);};
  menu.querySelector('[data-folder-autotag]').onclick=()=>{closeContextMenu();openGalleryAutoTagPicker(collection);};
  $('[data-folder-unlock]')?.addEventListener('click',()=>{closeContextMenu();requestGalleryPassword(collection,()=>{unlockedGalleryIds.add(collection.id);openGallery(collection.id);});});
  $('[data-folder-lock]')?.addEventListener('click',async()=>{if(!store.passwordHash){closeContextMenu();return toast('Set an app password before locking a Gallery');}collection.locked=true;unlockedGalleryIds.delete(collection.id);await save();closeContextMenu();if(currentView===`collection:${collection.id}`){currentView='library-folders';selectedId=null;selectedIds.clear();render();}else renderSidebars();});
  $('[data-folder-lock-now]')?.addEventListener('click',()=>{unlockedGalleryIds.delete(collection.id);closeContextMenu();if(currentView===`collection:${collection.id}`){lockedGalleryId=collection.id;selectedId=null;selectedIds.clear();render();}else renderSidebars();});
  $('[data-folder-unlock-permanently]')?.addEventListener('click',async()=>{if(!confirmAction(`Remove the lock permanently from Gallery “${collection.name}”?`))return;collection.locked=false;unlockedGalleryIds.add(collection.id);await save();closeContextMenu();render();});
  menu.querySelector('[data-folder-import]').onclick=()=>{closeContextMenu();importFolderIntoCollection(collection);};
  menu.querySelector('[data-folder-import-personal]').onclick=()=>{const other=store.collections.filter(item=>item.id!==collection.id);if(!other.length)return;menu.innerHTML=other.map(item=>`<button data-import-personal="${item.id}">${escapeHTML(item.name)}</button>`).join('');$$('[data-import-personal]').forEach(button=>button.onclick=async()=>{const source=store.collections.find(item=>item.id===button.dataset.importPersonal);source.items.forEach(id=>{if(!collection.items.includes(id))collection.items.push(id);});markManualItems(collection,source.items);await save();closeContextMenu();render();});};
  menu.querySelector('[data-folder-delete]').onclick=async()=>{if(!confirmAction(`Move Gallery “${collection.name}” to Discard Pile?`))return;store.discardedGalleries ||= [];store.discardedGalleries.push({...collection,items:[...(collection.items||[])],sourceIds:[...(collection.sourceIds||[])],discardedIds:[...(collection.discardedIds||[])],groups:JSON.parse(JSON.stringify(collection.groups||[])),deletedAt:Date.now()});store.collections=store.collections.filter(item=>item.id!==collection.id);store.galleryGroups=(store.galleryGroups||[]).map(group=>({...group,galleries:group.galleries.filter(id=>id!==collection.id)})).filter(group=>group.galleries.length>1);store.allMediaExcludedGalleryIds=(store.allMediaExcludedGalleryIds||[]).filter(id=>id!==collection.id);unlockedGalleryIds.delete(collection.id);if(currentView===`collection:${collection.id}`)currentView='all';await save();closeContextMenu();render();};
}
function openGroupContextMenu(event,groupId) { const group=activeGroups().find(item=>item.id===groupId),menu=$('#contextMenu');if(!group)return;menu.innerHTML=`<button data-group-select>Select all images in group</button><button data-group-folder>Add group to Folder</button><button data-group-collapse>${group.collapsed?'Expand group':'Collapse group'}</button>${currentCollection()?'<button data-group-cover>Set group cover</button>':''}`;menu.style.left=`${Math.min(event.clientX,window.innerWidth-245)}px`;menu.style.top=`${Math.min(event.clientY,window.innerHeight-210)}px`;menu.classList.remove('hidden');menu.querySelector('[data-group-select]').onclick=()=>{selectedIds=new Set(group.assets);selectedId=group.assets[0]||null;closeContextMenu();render();};menu.querySelector('[data-group-folder]').onclick=()=>{selectedIds=new Set(group.assets);selectedId=group.assets[0]||null;closeContextMenu();openBulkFolderPicker();};menu.querySelector('[data-group-collapse]').onclick=async()=>{group.collapsed=!group.collapsed;await save();closeContextMenu();renderCanvas();};menu.querySelector('[data-group-cover]')?.addEventListener('click',async()=>{currentCollection().coverId=group.coverId||group.assets[0];await save();closeContextMenu();renderSidebars();}); }
function openPropertyPicker(kind,anchor) {
  const ids=selectedTargetIds(); if(!ids.length)return;
  const picker=$('#propertyPicker'),isFolder=kind==='folder',field=kind==='theme'?'tags':'persons',definitions=isFolder?store.collections:(kind==='theme'?store.tagDefinitions:store.personDefinitions),rect=anchor.getBoundingClientRect();
  picker.style.left=`${Math.max(10,rect.left-195)}px`;picker.style.top=`${Math.min(window.innerHeight-270,rect.bottom+6)}px`;
  const renderOptions=needle=>{const term=needle.toLowerCase(),values=definitions.filter(item=>(item.name||'').toLowerCase().includes(term)),exact=definitions.some(item=>(item.name||'').toLowerCase()===term);picker.innerHTML=`<div class="picker-search"><span>⌕</span><input id="pickerSearch" placeholder="Search..." value="${escapeHTML(needle)}"></div><div class="picker-list">${values.map(item=>{const name=item.name;const selected=isFolder?ids.every(id=>item.items.includes(id)):ids.every(id=>meta(id)[field].includes(name));return `<button data-picker-value="${escapeHTML(isFolder?item.id:name)}">${selected?'✓ ':''}${escapeHTML(name)}</button>`;}).join('')||'<span class="picker-empty">No matching values</span>'}${!isFolder&&needle.trim()&&!exact?`<button class="picker-create" data-picker-create="${escapeHTML(needle.trim())}">＋ Create &quot;${escapeHTML(needle.trim())}&quot;</button>`:''}</div>`;const search=$('#pickerSearch');search.oninput=event=>renderOptions(event.target.value);search.focus();search.setSelectionRange(needle.length,needle.length);$('[data-picker-create]')?.addEventListener('click',async event=>{const name=event.currentTarget.dataset.pickerCreate,target=kind==='theme'?store.tagDefinitions:store.personDefinitions;target.push({name});ids.forEach(id=>{if(!meta(id)[field].includes(name))meta(id)[field].push(name);});await save();closePropertyPicker();renderInspector();});$$('[data-picker-value]').forEach(button=>button.onclick=async()=>{const value=button.dataset.pickerValue;if(isFolder){const collection=store.collections.find(item=>item.id===value);await toggleAssetFolder(value,!ids.every(id=>collection.items.includes(id)));}else{ids.forEach(id=>{if(!meta(id)[field].includes(value))meta(id)[field].push(value);});await save();renderInspector();}closePropertyPicker();});};renderOptions('');picker.classList.remove('hidden');
}
function closePropertyPicker() { $('#propertyPicker').classList.add('hidden'); }
function openTagManager(kind='theme') {
  const isTheme=kind==='theme', definitions=isTheme?store.tagDefinitions:store.personDefinitions, field=isTheme?'tags':'persons', title=isTheme?'Theme':'Character';
  const rows=definitions.map(tag=>{const count=allAssets.filter(asset=>meta(asset.id)[field].includes(tag.name)).length;return `<div class="tag-row" data-original="${escapeHTML(tag.name)}"><input class="tag-color" type="color" value="${tag.color}"><input class="tag-name-input" value="${escapeHTML(tag.name)}"><span class="tag-count">${count} media</span><button class="delete-tag">×</button></div>`;}).join('')||'<div class="tag-row empty-tag-row">No items yet</div>';
  openModal(`<div class="tag-manager property-manager"><div class="property-tabs"><button data-tag-kind="theme" class="${isTheme?'selected':''}">Theme</button><button data-tag-kind="character" class="${!isTheme?'selected':''}">Character</button></div><h2>${title}</h2><p>Manage reusable ${title.toLowerCase()} values for your library.</p><div class="tag-table">${rows}</div><div class="new-tag-row"><input id="newTagName" placeholder="Create ${title}"><input id="newTagColor" class="tag-color" type="color" value="${isTheme?'#a78bfa':'#74b996'}"><button id="createTag" class="primary-button">Create</button></div><div class="modal-footer"><button class="secondary-button" data-close>Close</button><button id="saveTagManager" class="primary-button">Save changes</button></div></div>`);
  $$('[data-tag-kind]').forEach(button=>button.onclick=()=>openTagManager(button.dataset.tagKind));
  $('#createTag').onclick=async()=>{const name=$('#newTagName').value.trim();if(!name||definitions.some(tag=>tag.name.toLowerCase()===name.toLowerCase()))return;definitions.push({name,color:$('#newTagColor').value});await save();openTagManager(kind);};
  $$('.delete-tag').forEach(button=>button.onclick=event=>event.currentTarget.closest('.tag-row').remove());
  $('#saveTagManager').onclick=async()=>{const next=[];$$('.tag-row[data-original]').forEach(row=>{const oldName=row.dataset.original,name=row.querySelector('.tag-name-input').value.trim();if(!name){replacePropertyEverywhere(field,oldName,null);return;}replacePropertyEverywhere(field,oldName,name);next.push({name,color:row.querySelector('.tag-color').value});});if(isTheme)store.tagDefinitions=next;else store.personDefinitions=next;await save();closeModal();render();};
}
function replacePropertyEverywhere(field,oldName,newName) { Object.values(store.assetMeta).forEach(item=>item[field]=(item[field]||[]).map(value=>value===oldName?newName:value).filter(Boolean)); if(field==='tags')store.collections.forEach(collection=>collection.defaultTags=collection.defaultTags.map(tag=>tag===oldName?newName:tag).filter(Boolean)); }
function openPasswordModal() { const hasLockedGallery=store.collections.some(gallery=>gallery.locked);openModal(`<h2>Mật khẩu Gallery</h2><p>${store.passwordHash?'Mật khẩu này chỉ dùng để khóa và mở Gallery; app vẫn luôn mở bình thường.':'Đặt mật khẩu nếu bạn muốn khóa một hoặc nhiều Gallery.'}</p><label>Mật khẩu mới</label><input id="passwordOne" type="password" autocomplete="new-password" placeholder="Ít nhất 4 ký tự"><label>Xác nhận mật khẩu</label><input id="passwordTwo" type="password" autocomplete="new-password" placeholder="Nhập lại mật khẩu"><div class="modal-footer">${store.passwordHash&&!hasLockedGallery?'<button class="secondary-button" id="removePassword">Gỡ mật khẩu</button>':''}<button class="secondary-button" data-close>Hủy</button><button class="primary-button" id="savePassword">Lưu mật khẩu</button></div>`); $('#savePassword').addEventListener('click',async()=>{const a=$('#passwordOne').value,b=$('#passwordTwo').value;if(a.length<4)return toast('Mật khẩu cần ít nhất 4 ký tự');if(a!==b)return toast('Mật khẩu xác nhận chưa khớp');store.passwordHash=await hash(a);await save();closeModal();toast('Đã cập nhật mật khẩu');});$('#removePassword')?.addEventListener('click',async()=>{if(store.collections.some(gallery=>gallery.locked))return toast('Gỡ khóa tất cả Gallery trước khi gỡ mật khẩu');store.passwordHash=null;await save();closeModal();toast('Đã gỡ mật khẩu');}); }
function openLanguageModal() { openModal(`<h2>${t('language')}</h2><p>${store.language==='vi'?'Chọn ngôn ngữ hiển thị cho Master Vision.':'Choose the display language for Master Vision.'}</p><div class="language-options"><button data-language="vi" class="language-choice ${store.language==='vi'?'selected':''}"><b>Tiếng Việt</b><small>Vietnamese</small></button><button data-language="en" class="language-choice ${store.language==='en'?'selected':''}"><b>English</b><small>English</small></button></div><div class="modal-footer"><button class="secondary-button" data-close>${store.language==='vi'?'Đóng':'Close'}</button></div>`);$$('[data-language]').forEach(button=>button.onclick=async()=>{store.language=button.dataset.language;await save();closeModal();applyLanguage();render();}); }
async function hash(value) { const bytes=new TextEncoder().encode(value); const out=await crypto.subtle.digest('SHA-256',bytes); return [...new Uint8Array(out)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function lockApp() { if(!store.passwordHash)return toast('Set a password first');sessionStorage.removeItem('master-vision-unlocked');showUnlock(); }
function showUnlock() { document.body.innerHTML=`<div class="unlock-screen"><div class="unlock-card"><div class="brand"><span class="brand-mark">M</span><span>Mosaic</span></div><h1>Không gian riêng tư</h1><p>Nhập mật khẩu để mở thư viện của bạn.</p><input type="password" id="unlockInput" autofocus placeholder="Mật khẩu"><button id="unlockButton" class="primary-button">Mở khóa</button><small id="unlockError"></small></div></div>`; const input=$('#unlockInput'),go=async()=>{if(await hash(input.value)===store.passwordHash){sessionStorage.setItem('master-vision-unlocked', store.passwordHash);location.reload()}else{$('#unlockError').textContent='Mật khẩu chưa chính xác';input.select();input.focus();}};$('#unlockButton').onclick=go;input.onkeydown=e=>{if(e.key==='Enter')go();};requestAnimationFrame(()=>input.focus()); }
function openModal(content) { $('#modal').innerHTML=content;$('#modalLayer').classList.remove('hidden');$$('[data-close]').forEach(b=>b.onclick=closeModal); } function closeModal(){$('#modalLayer').classList.add('hidden');}
function openAllMediaGalleryExclusion() {
  if(!store.collections.length)return toast('Chưa có Gallery để exclude');
  const selected=new Set(store.allMediaExcludedGalleryIds||[]);
  const rows=store.collections.map(gallery=>{const unavailable=!isGalleryAvailable(gallery);return `<label class="gallery-exclude-row"><input type="checkbox" data-all-media-exclude-gallery="${escapeHTML(gallery.id)}" ${selected.has(gallery.id)?'checked':''}><span>${escapeHTML(gallery.name)}</span><small>${unavailable?'? media · locked':`${(gallery.items||[]).length} media`}</small></label>`;}).join('');
  openModal(`<h2>Exclude Gallery</h2><p>Ẩn trong Main Gallery những media chỉ thuộc Gallery đã chọn. Media vẫn hiện nếu nó còn thuộc Gallery khác hoặc source thư viện khác.</p><p id="allMediaExcludedCount" class="exclude-gallery-count"></p><div class="gallery-exclude-list">${rows}</div><div class="modal-footer"><button id="clearAllMediaGalleryExclusion" class="secondary-button">Bỏ chọn tất cả</button><button data-close class="secondary-button">Hủy</button><button id="saveAllMediaGalleryExclusion" class="primary-button">Áp dụng</button></div>`);
  const updateExcludedCount=()=>{const ids=$$('[data-all-media-exclude-gallery]:checked').map(input=>input.dataset.allMediaExcludeGallery),knownIds=ids.filter(id=>isGalleryAvailable(store.collections.find(gallery=>gallery.id===id))),hasUnknown=ids.some(id=>!isGalleryAvailable(store.collections.find(gallery=>gallery.id===id))),count=excludedMainGalleryAssetCount(knownIds),summary=hasUnknown?(count?`${count} + ? files`:'? files'):`${count} media`;$('#allMediaExcludedCount').textContent=ids.length?`${summary} sẽ bị ẩn khỏi Main Gallery`:'Chưa có Gallery nào bị exclude';};
  $$('[data-all-media-exclude-gallery]').forEach(input=>input.onchange=updateExcludedCount);
  updateExcludedCount();
  $('#clearAllMediaGalleryExclusion').onclick=()=>{$$('[data-all-media-exclude-gallery]').forEach(input=>input.checked=false);updateExcludedCount();};
  $('#saveAllMediaGalleryExclusion').onclick=async()=>{
    store.allMediaExcludedGalleryIds=$$('[data-all-media-exclude-gallery]:checked').map(input=>input.dataset.allMediaExcludeGallery);
    selectedId=null;selectedIds.clear();
    await save();
    closeModal();
    render();
  };
}
function openAdvancedFilter() {
  const collection=currentCollection(),groups=managedTagGroups(collection),sources=(collection?.sourceIds?.length?collection.sourceIds:store.sources.map(source=>source.id)).map(id=>store.sources.find(source=>source.id===id)).filter(Boolean);
  const tagRows=groups.flatMap(group=>tagGroupDefinitions(group).map(definition=>{const key=`${group.id}::${definition.name}`;return `<label class="gallery-exclude-row"><input type="checkbox" data-filter-tag="${escapeHTML(key)}" ${advancedFilter.tags.includes(key)?'checked':''}><span>${escapeHTML(group.name)} · ${escapeHTML(definition.name)}</span></label>`;})).join('')||'<span class="muted-small">Chưa có tag trong các tag group đang dùng.</span>';
  const galleryRows=currentView==='all'?`<div class="filter-modal-section"><b>Filter by Gallery</b>${store.collections.map(gallery=>`<label class="gallery-exclude-row"><input type="checkbox" data-filter-gallery="${gallery.id}" ${advancedFilter.galleryIds.includes(gallery.id)?'checked':''}><span>${escapeHTML(gallery.name)}</span><small>${gallery.locked&&!unlockedGalleryIds.has(gallery.id)?'locked':`${(gallery.items||[]).length} media`}</small></label>`).join('')}</div>`:'';
  const sourceRows=`<div class="filter-modal-section"><b>Filter by Media Src</b>${sources.map(source=>`<label class="gallery-exclude-row"><input type="checkbox" data-filter-source="${source.id}" ${advancedFilter.sourceIds.includes(source.id)?'checked':''}><span>${escapeHTML(source.name)}</span><small>${(source.assets||[]).length} media</small></label>`).join('')||'<span class="muted-small">Không có media source.</span>'}</div>`;
  openModal(`<h2>Filter media</h2><p>Tag dùng điều kiện “hoặc”; các loại filter khác áp dụng đồng thời.</p><div class="filter-modal-section"><b>Filter by tag</b><div class="gallery-exclude-list">${tagRows}</div></div>${galleryRows}${sourceRows}<div class="modal-footer"><button id="clearAdvancedFilter" class="secondary-button">Clear</button><button data-close class="secondary-button">Hủy</button><button id="saveAdvancedFilter" class="primary-button">Áp dụng</button></div>`);
  $('#clearAdvancedFilter').onclick=()=>{$$('[data-filter-tag],[data-filter-gallery],[data-filter-source]').forEach(input=>input.checked=false);};
  $('#saveAdvancedFilter').onclick=()=>{advancedFilter={tags:$$('[data-filter-tag]:checked').map(input=>input.dataset.filterTag),galleryIds:$$('[data-filter-gallery]:checked').map(input=>input.dataset.filterGallery),sourceIds:$$('[data-filter-source]:checked').map(input=>input.dataset.filterSource)};assetViewCache=null;closeModal();render();};
}
function bindEvents() {
  window.vision.onFolderChanged(scheduleSourceRefresh);
  window.vision.onMediaImported(reloadImportedMedia);
  $('#emptyAdd').onclick=()=>openCollectionModal();$('#libraryHome').onclick=()=>{currentView='library-folders';selectedId=null;selectedIds.clear();render();};$('#addCollection').onclick=()=>openCollectionModal();$('#addLibrarySource').onclick=addSource;$('#advancedFilter').onclick=openAdvancedFilter;$('#allMediaExcludeGalleries').onclick=openAllMediaGalleryExclusion;$('#manageTags').onclick=()=>{currentView='tag-manager';selectedId=null;selectedIds.clear();render();};$('#settingsButton').onclick=()=>{currentView='settings';selectedId=null;selectedIds.clear();render();};$('#toggleInspector').onclick=()=>$('#inspector').classList.toggle('hidden');$('#closeInspector').onclick=()=>$('#inspector').classList.add('hidden');
  $$('.nav-item[data-view]').forEach(button=>button.onclick=()=>{currentView=button.dataset.view;selectedId=null;render();}); $$('.filter-chip').forEach(button=>button.onclick=()=>{currentFilter=button.dataset.filter;$$('.filter-chip').forEach(x=>x.classList.toggle('selected',x===button));renderCanvas();});
  $('#searchInput').oninput=event=>{searchTerm=event.target.value;renderCanvas();}; $('#sortButton').onclick=()=>{allAssets.reverse();renderCanvas();}; $('#clearLayout').onclick=async()=>{allAssets.forEach((asset,index)=>meta(asset.id).order=Date.now()-index);await save();renderCanvas();};$('#editCollection').onclick=()=>openCollectionModal(currentCollection());
  $('#selectAll').onclick=()=>{const ids=visibleAssets().map(asset=>asset.id);selectedIds=selectedIds.size===ids.length?new Set():new Set(ids);selectedId=[...selectedIds].at(-1)||null;render();}; $('#zoomIn').onclick=async()=>{store.zoom=Math.min(280,(store.zoom||155)+15);applyZoom();await save();renderCanvas();};$('#zoomOut').onclick=async()=>{store.zoom=Math.max(80,(store.zoom||155)-15);applyZoom();await save();renderCanvas();};$('#refreshMedia').onclick=()=>refreshSources(currentCollection()?.sourceIds);$$('[data-bulk]').forEach(button=>button.onclick=()=>({folder:openBulkFolderPicker,group:bulkCreateGroup,tag:openBulkTagPicker,hide:async()=>{const ids=[...selectedIds];if(ids.length&&confirmAction(`Move ${ids.length} selected images to Discard Pile?`))await discardAssets(ids);},copy:async()=>{const first=allAssets.find(asset=>selectedIds.has(asset.id)&&asset.type==='image');if(first)await window.vision.copyImage(first);toast(`Copied ${selectedIds.size} selected image(s)`);},dissolve:dissolveSelectedGroup}[button.dataset.bulk]()));
  $('#favoriteToggle').onchange=async event=>{selectedTargetIds().forEach(id=>meta(id).favorite=event.target.checked);await save();renderCanvas();}; $('#assetNote').onchange=async event=>{selectedTargetIds().forEach(id=>meta(id).note=event.target.value);await save();};$('#removeFromCollection').onclick=removeFromCollection;
  $$('.property-add').forEach(button=>button.onclick=event=>{event.stopPropagation();openPropertyPicker(button.dataset.picker,button);}); $('#inspector').addEventListener('click',event=>{const button=event.target.closest('[data-pill-field]');if(button)removeValue(button.dataset.pillField,button.dataset.pillValue);const folder=event.target.closest('[data-remove-folder]');if(folder)toggleAssetFolder(folder.dataset.removeFolder,false);}); $('#modalLayer').onclick=event=>{if(event.target===$('#modalLayer'))closeModal();}; document.addEventListener('click',event=>{if(!event.target.closest('#contextMenu'))closeContextMenu();if(!event.target.closest('#propertyPicker')&&!event.target.closest('.property-add'))closePropertyPicker();});
  $('#content').addEventListener('scroll',event=>{const content=event.currentTarget;canvasScrollDirection=content.scrollTop>=lastCanvasScrollTop?'down':'up';lastCanvasScrollTop=content.scrollTop;$('#scrollTop').classList.toggle('hidden',content.scrollTop<260);if(!$('#canvas').classList.contains('asset-canvas')||canvasRenderLimit>=visibleAssets().length||content.scrollTop+content.clientHeight<content.scrollHeight-640)return;queueNextCanvasBatch();}); $('#content').addEventListener('dragover',event=>{if(dragId||dragGroupId){event.preventDefault();updateAutoScroll(event);}}); $('#content').addEventListener('dragleave',event=>{if(!$('#content').contains(event.relatedTarget))stopAutoScroll();}); $('#scrollTop').onclick=()=>$('#content').scrollTo({top:0,behavior:'smooth'});
  $('#closeLightbox').onclick=closeLightbox; $('#previousAsset').onclick=()=>moveLightbox(-1); $('#nextAsset').onclick=()=>moveLightbox(1); $('#lightbox').addEventListener('click',event=>{if(event.target===$('#lightbox'))closeLightbox();}); document.addEventListener('keydown',event=>{if(handleVideoSpeedShortcut(event))return;if($('#lightbox').classList.contains('hidden'))return; if(event.key==='Escape')closeLightbox(); if(event.key==='ArrowLeft'){event.preventDefault();moveLightbox(-1);} if(event.key==='ArrowRight'){event.preventDefault();moveLightbox(1);}});
}
init();
