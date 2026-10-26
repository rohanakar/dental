import type { ReactNode, SVGProps } from 'react';

/**
 * The app's icons: one 16×16 grid, 1.5 px round strokes, `currentColor`.
 * Decorative by default (aria-hidden); the control that holds an icon names
 * the action.
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const UndoIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6 3.5 3 6.5l3 3" />
    <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
  </Icon>
);

export const RedoIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 3.5l3 3-3 3" />
    <path d="M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9" />
  </Icon>
);

export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const RotateLeftIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 3v3.5H7" />
    <path d="M3.8 6.3A5 5 0 1 1 3.4 10" />
  </Icon>
);

export const RotateRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12.5 3v3.5H9" />
    <path d="M12.2 6.3A5 5 0 1 0 12.6 10" />
  </Icon>
);

export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Icon>
);

/** A failed check: a cross in a circle, so it reads without colour. */
export const FailIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6 6l4 4M10 6l-4 4" />
  </Icon>
);

/** Not measured yet: a dashed circle. */
export const UnknownIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" strokeDasharray="2.2 2.2" />
  </Icon>
);

export const AlertIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 2.5 14 13H2L8 2.5z" />
    <path d="M8 6.5v3" />
    <path d="M8 11.3v.01" />
  </Icon>
);

export const CameraIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 5.5h2.2L6 3.8h4l1.3 1.7h2.2v7h-11z" />
    <circle cx="8" cy="9" r="2.2" />
  </Icon>
);

/** Dark theme off: switch to dark. */
export const MoonIcon = (p: P) => (
  <Icon {...p}>
    <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z" />
  </Icon>
);

/** Dark theme on: switch to light. */
export const SunIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Icon>
);
