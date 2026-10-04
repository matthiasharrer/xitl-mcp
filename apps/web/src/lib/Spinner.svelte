<!-- Centered loading indicator for a view's first load. It fades in after a
     short delay, so fast loads (the usual case on the LAN) don't flash. -->
<div class="spinner-wrap" role="status" aria-label="Lädt">
  <span class="spinner"></span>
</div>

<style>
  /* Centered on the screen, not in the (still empty) content area; it never
     blocks taps on the header or tab bar. */
  .spinner-wrap {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .spinner {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 3px solid var(--border);
    border-top-color: var(--accent-text);
    opacity: 0;
    animation:
      spinner-in 150ms ease-out 200ms forwards,
      spinner-turn 0.8s linear infinite;
  }
  @keyframes spinner-in {
    to { opacity: 1; }
  }
  @keyframes spinner-turn {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: spinner-in 150ms ease-out 200ms forwards, spinner-turn 2.4s linear infinite; }
  }
</style>
