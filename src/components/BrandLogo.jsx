/** Dual brand mark (Swift STV → Swiftya Latino) used in topbar, login, exit. */
export default function BrandLogo({ className = '', size = 'md', showWordmark = false }) {
  return (
    <span className={`brand-mark brand-mark--${size} ${className}`.trim()}>
      <img
        className="brand-mark-img"
        src="/brand/logo-dual.jpg"
        alt="Swift STV · Swiftya Latino"
        draggable={false}
      />
      {showWordmark ? (
        <span className="brand-mark-text">
          <span className="brand-mark-title">Swift STV</span>
          <span className="brand-mark-sub">Swiftya Latino</span>
        </span>
      ) : null}
    </span>
  );
}
