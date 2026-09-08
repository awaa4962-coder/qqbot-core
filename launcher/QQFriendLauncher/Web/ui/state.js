

export const host = window.QQFriendHost;

// Shared view state is module-scoped; page renderers and action dispatch use the same instance.
export const uiState = {
  activeActions: new Map(),
  activityHideTimer: null,
  currentView: "overview",
  lastStatus: {},
  lastConfigSnapshot: {},
  latestStatusTime: 0,
  logLines: [],
  logsLoaded: false,
  configBaseline: "",
  configDirty: false,
  memesLoaded: false,
  memeSnapshot: { entries: [], candidates: [] },
  memeSelectionMode: "entry",
  memeBaseline: "",
  memeDirty: false,
  lastEntrySelection: "",
  memeEditingOriginalName: "",
  stickersLoaded: false,
  stickerSnapshot: { entries: [], settings: {}, counts: {}, stats: {} },
  selectedStickerId: "",
  stickerFilter: "sendable",
  stickerImageObservers: new WeakMap(),
  logFollow: false,
  lastBridgeOnline: null,
  bridgeIntentionallyStopped: false,
  capabilitiesLoaded: false,
  capabilitySnapshot: { categories: [], capabilities: [] },
  apiProvidersLoaded: false,
  apiSnapshot: { providers: [], presets: [], protocols: [], routes: {}, tasks: [] },
  selectedApiProviderId: "",
  apiEditorMode: "edit",
};
export { uiState as state };
