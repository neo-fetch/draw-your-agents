/**
 * Breadcrumb bar for nested workflow editing (ADR-0050). Renders nothing at
 * the root; while zoomed into a sub-graph it shows the path from the root IR
 * through every workflow node, with each ancestor segment clickable to jump
 * back out. The last segment is the graph currently on the canvas.
 */
import { useIRStore } from "../store/irStore.ts";
import { breadcrumbItems } from "../store/subgraph.ts";

export function SubgraphBreadcrumb() {
  const ir = useIRStore((s) => s.ir);
  const subgraphPath = useIRStore((s) => s.subgraphPath);
  const setSubgraphPath = useIRStore((s) => s.setSubgraphPath);

  if (subgraphPath.length === 0) return null;
  // A transiently invalid path renders nothing; the canvas already falls
  // back to the root via `selectActiveGraph`.
  const items = breadcrumbItems(ir, subgraphPath);
  if (!items) return null;

  return (
    <nav className="subgraph-breadcrumb" aria-label="Sub-graph location">
      <button
        type="button"
        className="subgraph-breadcrumb__segment"
        onClick={() => setSubgraphPath([])}
      >
        {ir.name}
      </button>
      {items.map((item, i) => {
        const isCurrent = i === items.length - 1;
        return (
          <span key={item.id} className="subgraph-breadcrumb__crumb">
            <span className="subgraph-breadcrumb__sep" aria-hidden="true">
              ›
            </span>
            {isCurrent ? (
              <span
                className="subgraph-breadcrumb__segment subgraph-breadcrumb__segment--current"
                aria-current="location"
              >
                {item.name}
              </span>
            ) : (
              <button
                type="button"
                className="subgraph-breadcrumb__segment"
                onClick={() => setSubgraphPath(subgraphPath.slice(0, i + 1))}
              >
                {item.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
