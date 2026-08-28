export const LS_POS = 'dsh-vau:pos';
export const LS_COLLAPSED = 'dsh-vau:collapsed';
/** Last auto-expand key the user dismissed (survives DSH restart). */
export const LS_DISMISS_KEY = 'dsh-vau:dismiss-key';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const CAPSULE_W = 148;
export const PANEL_W = 248;
export const PANEL_MAX_H = 360;
export const PANEL_EST_H = 300;
export const CAPSULE_EST_H = 28;
export const VIEW_MARGIN = 8;
export const PANEL_GAP = 5;
export const DRAG_THRESHOLD = 4;
export const DEFAULT_TOP = 48;
export const DEFAULT_RIGHT = 16;
export const Z_INDEX = 10050;

export const SCROLLBAR_CSS = `
  .dsh-vau-panel-body::-webkit-scrollbar,
  .dsh-vau-panel pre::-webkit-scrollbar { width: 8px; height: 8px; }
  .dsh-vau-panel-body::-webkit-scrollbar-track,
  .dsh-vau-panel pre::-webkit-scrollbar-track { background: rgba(255,255,255,0.04); border-radius: 4px; }
  .dsh-vau-panel-body::-webkit-scrollbar-thumb,
  .dsh-vau-panel pre::-webkit-scrollbar-thumb { background: rgba(161,161,170,0.45); border-radius: 4px; }
  .dsh-vau-panel-body::-webkit-scrollbar-thumb:hover,
  .dsh-vau-panel pre::-webkit-scrollbar-thumb:hover { background: rgba(161,161,170,0.7); }
  .dsh-vau-panel-body { scrollbar-width: thin; scrollbar-color: rgba(161,161,170,0.45) rgba(255,255,255,0.04); }
`;
