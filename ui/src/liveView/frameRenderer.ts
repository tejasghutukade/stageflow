export type FrameRenderer = {
  draw(base64Jpeg: string): void;
  size(): { width: number; height: number } | null;
  dispose(): void;
};

export function createFrameRenderer(canvas: HTMLCanvasElement): FrameRenderer {
  const ctx = canvas.getContext("2d");
  let decoding = false;
  let latest: string | null = null;
  let disposed = false;
  let size: { width: number; height: number } | null = null;

  function next(): void {
    if (decoding || disposed || latest === null || ctx === null) return;
    const data = latest;
    latest = null;
    decoding = true;
    const img = new Image();
    img.onload = () => {
      decoding = false;
      if (disposed) return;
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      size = { width: img.naturalWidth, height: img.naturalHeight };
      ctx.drawImage(img, 0, 0);
      next();
    };
    img.onerror = () => {
      decoding = false;
      next();
    };
    img.src = `data:image/jpeg;base64,${data}`;
  }

  return {
    draw(base64Jpeg) {
      latest = base64Jpeg;
      next();
    },
    size: () => size,
    dispose() {
      disposed = true;
    },
  };
}
