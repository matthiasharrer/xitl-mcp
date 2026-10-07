<script lang="ts">
  // An on/off switch (a checkbox with role="switch"): used for "Aktiv" =
  // not paused (ADR-0033 upstreams, ADR-0024 clients). The parent owns the
  // value; `onchange` gets the wanted state and the parent reloads.
  interface Props {
    checked: boolean;
    label: string;
    disabled?: boolean;
    onchange: (on: boolean) => void;
  }
  let { checked, label, disabled = false, onchange }: Props = $props();
</script>

<span class="switch">
  <input
    type="checkbox"
    role="switch"
    aria-label={label}
    {checked}
    {disabled}
    onchange={(e) => {
      const on = e.currentTarget.checked;
      e.currentTarget.checked = checked; // stays as it is until the parent has the new state
      onchange(on);
    }}
  />
  <span aria-hidden="true"></span>
</span>

<style>
  .switch {
    position: relative;
    flex: none;
    width: 52px;
    height: 32px;
  }
  input {
    position: absolute;
    inset: -8px -4px;
    width: calc(100% + 8px);
    height: calc(100% + 16px);
    opacity: 0;
    margin: 0;
    cursor: pointer;
  }
  input:disabled {
    cursor: default;
  }
  span span {
    /* the track is drawn after the input: let taps through to it (no
     * z-index on the input, so fixed bars always cover it) */
    pointer-events: none;
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: var(--border);
    transition: background 0.15s;
  }
  span span::after {
    content: '';
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: transform 0.15s;
  }
  input:checked + span {
    background: var(--accent);
  }
  input:checked + span::after {
    transform: translateX(20px);
  }
  input:disabled + span {
    opacity: 0.5;
  }
  input:focus-visible + span {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    span span,
    span span::after {
      transition: none;
    }
  }
</style>
