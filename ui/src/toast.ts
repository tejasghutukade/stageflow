let toastEl: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, durationMs = 4000): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.setAttribute("data-show", "true");
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toastEl?.setAttribute("data-show", "false");
  }, durationMs);
}
