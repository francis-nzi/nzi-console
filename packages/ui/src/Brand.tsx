// The NZI brand (BRAND-logo kickoff, ruled 6 Oct): Francis's logos, served as static assets from the console's
// public/brand — WebP first, PNG as the fallback — never inlined or recoloured. The full lockup is designed for a white
// ground, so on the dark chrome it sits on a white plate; the tree mark (an orange circle) stands where the full lockup
// will not fit.

const BRAND_ALT = "net zero. international";

/** The full lockup — tree-in-circle + "net zero. / international". For a white ground only. */
export function NziLogo({ className }: { className?: string }) {
  return (
    <picture className={className}>
      <source srcSet="/brand/netzero-logo.webp" type="image/webp" />
      <img src="/brand/netzero-logo.png" alt={BRAND_ALT} width={1428} height={600} decoding="async" />
    </picture>
  );
}

/** The tree mark alone — for small and collapsed slots, in place of the old "N" tile. */
export function NziMark({ className }: { className?: string }) {
  return (
    <span className={className ? `nz-brand-mark ${className}` : "nz-brand-mark"}>
      <picture>
        <source srcSet="/brand/netzero-logo-big-tree.webp" type="image/webp" />
        <img src="/brand/netzero-logo-big-tree.png" alt={BRAND_ALT} width={1200} height={1200} decoding="async" />
      </picture>
    </span>
  );
}
