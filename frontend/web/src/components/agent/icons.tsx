import type { ReactElement, ReactNode } from 'react';

export interface IconProps {
  size?: number;
  className?: string;
}

/** An inline SVG icon: `currentColor` stroke, aria-hidden, sized by the caller. */
export type IconComponent = (props: IconProps) => ReactElement;

function createIcon(shape: ReactNode): IconComponent {
  function Icon({ size = 16, className }: IconProps): ReactElement {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        {shape}
      </svg>
    );
  }
  return Icon;
}

export const Sparkles = createIcon(
  <>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
    <path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
  </>,
);

export const Plus = createIcon(<path d="M12 5v14M5 12h14" />);

export const Send = createIcon(<path d="M21.5 2.5L11 13M21.5 2.5l-6.7 19-3.8-8.5-8.5-3.8 19-6.7z" />);

export const Stop = createIcon(<rect x="6" y="6" width="12" height="12" rx="2.5" />);

export const ImagePlus = createIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="M4.5 17l4.5-4.5 4 4 2.2-2.2 4.3 4.2" />
    <path d="M17.5 4.5v4M15.5 6.5h4" />
  </>,
);

export const Trash = createIcon(<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.9 12.1a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7M10 11v5M14 11v5" />);

export const Pencil = createIcon(<path d="M4 20l4.6-1.1L19 8.5a2.1 2.1 0 0 0-3-3L5.6 15.9 4 20zM13.5 6.5l3.9 3.9" />);

export const Check = createIcon(<path d="M5 12.5l4.5 4.5L19 7.5" />);

export const ChevronDown = createIcon(<path d="M6 9l6 6 6-6" />);

export const ChevronLeft = createIcon(<path d="M15 6l-6 6 6 6" />);

export const ChevronRight = createIcon(<path d="M9 6l6 6-6 6" />);

export const Menu = createIcon(<path d="M4 7h16M4 12h16M4 17h16" />);

export const Calendar = createIcon(
  <>
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </>,
);

export const ListTodo = createIcon(
  <>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M3.5 6l1.3 1.3L7.2 4.8M3.5 12l1.3 1.3L7.2 10.8M3.5 18l1.3 1.3L7.2 16.8" />
  </>,
);

export const Clock = createIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.4 2" />
  </>,
);

export const Alert = createIcon(
  <>
    <path d="M12 3.5L21 20.5H3L12 3.5z" />
    <path d="M12 10v4.5M12 17.8v.1" />
  </>,
);

export const Loader = createIcon(<path d="M12 3a9 9 0 1 0 9 9" />);

export const Copy = createIcon(
  <>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </>,
);

export const X = createIcon(<path d="M6 6l12 12M18 6L6 18" />);

export const ArrowUp = createIcon(<path d="M12 20V4M5 11l7-7 7 7" />);

export const ArrowDown = createIcon(<path d="M12 4v16M5 13l7 7 7-7" />);

export const Sidebar = createIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </>,
);

export const Grid = createIcon(
  <>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </>,
);

export const Sliders = createIcon(
  <>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </>,
);

/**
 * Tool name to icon. Reads are calendar/clock, tasks are lists, and the
 * special tools get the sparkle; anything else falls back to a neutral grid so
 * a new tool never renders an empty row.
 */
const TOOL_ICONS: Record<string, IconComponent> = {
  get_agenda: Clock,
  find_free_slots: Clock,
  suggest_tasks: ListTodo,
  search_tasks: ListTodo,
  get_task: ListTodo,
  get_tree: ListTodo,
  create_task: ListTodo,
  create_tasks: ListTodo,
  update_task: ListTodo,
  complete_task: ListTodo,
  move_node: ListTodo,
  delete_node: ListTodo,
  create_event: Calendar,
  update_event: Calendar,
  cancel_event: Calendar,
  create_recurring: Calendar,
  cancel_recurring: Calendar,
  list_rules: Sliders,
  ask_user: Sparkles,
  import_timetable: Sparkles,
};

export function toolIcon(name: string): IconComponent {
  return TOOL_ICONS[name] ?? Grid;
}
