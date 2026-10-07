import { wsDir } from "./paths";

export const PER_PAGE = 4;

const q = (s: string) => JSON.stringify(s); // JSON strings are valid KDL strings

/** Zellij layout: one tab per page, each page a row of up to 4 workspace columns (Claude above shell). */
export function layoutKdl(workspaces: string[], self: string[]): string {
  const [cmd, ...baseArgs] = self;
  const tabs: string[] = [];
  for (let i = 0; i < workspaces.length; i += PER_PAGE) {
    const page = workspaces.slice(i, i + PER_PAGE);
    const columns = page.map((ws) => {
      const args = [...baseArgs, "claude", ws].map(q).join(" ");
      return `      pane split_direction="horizontal" {
        pane name=${q(`${ws} · claude`)} command=${q(cmd!)} cwd=${q(wsDir(ws))} size="65%" {
          args ${args}
        }
        pane name=${q(`${ws} · shell`)} cwd=${q(wsDir(ws))}
      }`;
    });
    tabs.push(`  tab name=${q(page.join(" "))}${i === 0 ? " focus=true" : ""} {
    pane split_direction="vertical" {
${columns.join("\n")}
    }
  }`);
  }
  return `layout {
  default_tab_template {
    pane size=1 borderless=true {
      plugin location="zellij:tab-bar"
    }
    children
    pane size=1 borderless=true {
      plugin location="zellij:status-bar"
    }
  }
${tabs.join("\n")}
}
`;
}
