import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { useToast } from "../../components/Toast";
import { bannerComplete, bannerTicket } from "./appCoursesApi";
import { postToS3 } from "./appVideosApi";
import {
  BANNER_H,
  BANNER_W,
  bannerFile,
  DEFAULT_FRAMING,
  drawBanner,
  drawOwn,
  edgeColor,
  edgeState,
  fitZoom,
  loadImage,
  looksSoft,
  MAX_ZOOM,
  minZoom,
  ownFile,
  ownShapeFits,
  placement,
  SAFE_INSET,
  type Framing,
} from "./bannerFit";

type Preset = "own" | "fill" | "whole" | "safe" | "custom";
const PRESETS: { id: Exclude<Preset, "custom">; label: string }[] = [
  { id: "own", label: "Whole image as it is (the card takes its shape)" },
  { id: "fill", label: "Fill the card (crop)" },
  { id: "whole", label: "Show the whole image" },
  { id: "safe", label: "Whole image inside the dashed line" },
];
const EDGE_TEXT = {
  safe: "Nothing is cut: the whole image is inside the dashed line.",
  inside: "Nothing is cut here, but some of the image is outside the dashed line: the app's gentle zoom may trim it a little.",
  cut: "The parts outside the card are cut. Slide Zoom to the left to shrink the image on every side, or pick an option above.",
} as const;

const PREVIEW_W = 600;
const PREVIEW_H = Math.round((PREVIEW_W * BANNER_H) / BANNER_W);

/** Choose an image and upload it as the card shows it. By default the whole picture in its own shape
 * (the app's card takes that shape: nothing cut, no bands); or framed in the classic 1200 x 520 card
 * shape in a preview that matches the app. Nothing is cut that the owner didn't choose. */
export function BannerEditor({ batchId, dark, label, onUploaded, onFile, actionLabel = "Use this banner", disabled }: {
  batchId: string;
  dark: boolean;
  label: string;
  onUploaded?: (key: string) => void;
  /** Hand the finished file to the caller instead of uploading it as a batch banner. */
  onFile?: (file: File) => void | Promise<void>;
  actionLabel?: string;
  disabled?: boolean;
}) {
  const ids = { file: useId(), zoom: useId(), x: useId(), y: useId() };
  const toast = useToast();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [background, setBackground] = useState("#eef1f6");
  const [framing, setFraming] = useState<Framing>(DEFAULT_FRAMING);
  const [preset, setPreset] = useState<Preset>("own");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const own = preset === "own";
  // The preview: the picture in its own shape, or the classic card shape.
  const previewH = own && img ? Math.max(1, Math.round((PREVIEW_W * img.height) / img.width)) : PREVIEW_H;
  useEffect(() => {
    const ctx = img && canvas.current?.getContext("2d");
    if (!img || !ctx) return;
    if (own) drawOwn(ctx, img, PREVIEW_W, previewH);
    else drawBanner(ctx, img, framing, PREVIEW_W, PREVIEW_H, background);
  }, [img, framing, background, own, previewH]);

  useEffect(() => () => { if (img?.src.startsWith("blob:")) URL.revokeObjectURL(img.src); }, [img]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    try {
      const loaded = await loadImage(file);
      setImg(loaded);
      setBackground(edgeColor(loaded));
      setFraming(DEFAULT_FRAMING);
      setPreset("own");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That image can't be opened.");
    }
  }

  async function upload() {
    if (!img) return;
    if (!onFile && !/^[a-z0-9_]{3,64}$/.test(batchId)) return setProblem("Give the batch a name first.");
    setBusy(true);
    setProblem(null);
    try {
      const name = `${batchId}${dark ? "-dark" : ""}`;
      const file = own ? await ownFile(img, name) : await bannerFile(img, framing, background, name);
      if (onFile) {
        await onFile(file);
        setImg(null);
        return;
      }
      const t = await bannerTicket({ batch_id: batchId, dark, filename: file.name, size_bytes: file.size });
      await postToS3(t, file, () => undefined);
      await bannerComplete(t.key);
      onUploaded?.(t.key);
      setImg(null);
    } catch (err) {
      toast.error(err, "The banner couldn't be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  // Drag the picture: it follows the pointer, at any size.
  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (own) return; // the whole picture: nothing to move
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: framing.x, y: framing.y };
  }
  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current;
    if (!start || !img) return;
    const shown = e.currentTarget.getBoundingClientRect();
    const p = placement(img.width, img.height, { ...framing, x: start.x, y: start.y });
    const freeX = BANNER_W - p.w; // room to move: negative when the image is wider than the card
    const freeY = BANNER_H - p.h;
    const dx = ((e.clientX - start.px) / (shown.width || 1)) * BANNER_W;
    const dy = ((e.clientY - start.py) / (shown.height || 1)) * BANNER_H;
    setPreset("custom");
    setFraming((f) => ({
      ...f,
      x: Math.abs(freeX) > 0.5 ? Math.min(1, Math.max(0, start.x + dx / freeX)) : f.x,
      y: Math.abs(freeY) > 0.5 ? Math.min(1, Math.max(0, start.y + dy / freeY)) : f.y,
    }));
  }
  const endDrag = () => { drag.current = null; };

  const set = (patch: Partial<Framing>) => { setPreset("custom"); setFraming((f) => ({ ...f, ...patch })); };
  function choosePreset(p: Exclude<Preset, "custom">) {
    if (!img) return;
    setPreset(p);
    if (p === "own") return;
    const zoom = p === "fill" ? 1 : fitZoom(img.width, img.height, p === "safe" ? SAFE_INSET : 0);
    setFraming({ zoom, x: 0.5, y: 0.5 });
  }
  const soft = img ? (own ? img.width < 900 : looksSoft(img.width, img.height, framing)) : false;
  const ownFits = img ? ownShapeFits(img.width, img.height) : true;
  const edges = img ? edgeState(img.width, img.height, framing) : "safe";
  const zoomMin = img ? Math.floor(minZoom(img.width, img.height) * 100) / 100 : 1;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label htmlFor={ids.file} className="small">{label}</label>
      <input id={ids.file} type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={disabled || busy}
        onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
      {img && (
        <>
          <div style={{ position: "relative", borderRadius: 8, overflow: "hidden" }}>
            <canvas ref={canvas} width={PREVIEW_W} height={previewH} aria-label={`${label}: preview as the app shows it`}
              style={{ width: "100%", aspectRatio: `${PREVIEW_W} / ${previewH}`, display: "block", cursor: own ? "default" : "grab", touchAction: "none" }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
            {!own && (
              <div aria-hidden="true" style={{ position: "absolute", inset: `${SAFE_INSET * 100}%`, border: "1px dashed rgba(255,255,255,0.9)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.35)", borderRadius: 4, pointerEvents: "none" }} />
            )}
          </div>
          <span className="hint">
            {own
              ? "Exactly what the app's card shows: the card takes this picture's shape, so the whole picture shows, with no empty bands and nothing cut."
              : `Exactly what the app's card shows in the classic ${BANNER_W} × ${BANNER_H} shape. Keep text inside the dashed line: older app versions zoom gently and trim the edges. Drag the picture, or use the sliders.`}
          </span>
          <fieldset className="field">
            <legend>How the image fills the card</legend>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              {PRESETS.map((p) => (
                <label key={p.id} className="checkbox">
                  <input type="radio" name={`${ids.file}-mode`} checked={preset === p.id} onChange={() => choosePreset(p.id)} /> {p.label}
                </label>
              ))}
            </div>
          </fieldset>
          {own && !ownFits && (
            <span className="error" role="status">
              This picture is very {img!.width < img!.height ? "tall" : "wide"}: the app's card can't take its shape, so its edges would be cut. Pick another option.
            </span>
          )}
          {!own && (<>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 140px" }}>
              <label htmlFor={ids.zoom}>Zoom</label>
              <input id={ids.zoom} type="range" min={zoomMin} max={MAX_ZOOM} step={0.01} value={framing.zoom}
                aria-valuetext={`${Math.round(framing.zoom * 100)}% of the card`} onChange={(e) => set({ zoom: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ flex: "1 1 140px" }}>
              <label htmlFor={ids.x}>Left – right</label>
              <input id={ids.x} type="range" min={0} max={1} step={0.01} value={framing.x} onChange={(e) => set({ x: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ flex: "1 1 140px" }}>
              <label htmlFor={ids.y}>Up – down</label>
              <input id={ids.y} type="range" min={0} max={1} step={0.01} value={framing.y} onChange={(e) => set({ y: Number(e.target.value) })} />
            </div>
          </div>
          <span className="hint">
            Zoom to the left shrinks the image on every side; the space around it takes the colour of the image's edges.
          </span>
          <span className={edges === "cut" ? "hint" : "small"} role="status">{EDGE_TEXT[edges]}</span>
          </>)}
          {soft && <span className="error">This image is small for a card about {BANNER_W} pixels across: it may look blurry in the app. A larger image looks sharper.</span>}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void upload()} disabled={busy}>{busy ? "Preparing…" : actionLabel}</button>
            <button type="button" className="btn btn-sm" onClick={() => setImg(null)} disabled={busy}>Cancel</button>
          </div>
        </>
      )}
      {problem && <span className="error" role="alert">{problem}</span>}
    </div>
  );
}
