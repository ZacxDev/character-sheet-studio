// Breadcrumb trail for sub-pages: where you are, and one click back up.
// Crumbs are anchors (role "link", not "button") so they never collide
// with the side-nav buttons that share their labels.

export interface Crumb {
  label: string;
  /** Route path to navigate to; omit for the current page (last crumb). */
  path?: string;
}

export function Breadcrumbs({
  items,
  onNavigate,
}: {
  items: Crumb[];
  onNavigate: (path: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <nav className="css-crumbs" aria-label="Breadcrumb" data-testid="breadcrumbs">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} className="css-crumb-wrap">
            {i > 0 && (
              <span className="css-crumb-sep" aria-hidden="true">
                ›
              </span>
            )}
            {last || !item.path ? (
              <span className="css-crumb-current" aria-current="page">
                {item.label}
              </span>
            ) : (
              <a
                className="css-crumb"
                href={item.path}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(item.path!);
                }}
              >
                {item.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}
