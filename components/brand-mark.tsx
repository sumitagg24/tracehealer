import type { SVGProps } from "react";

export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="32" height="32" rx="9" fill="url(#brand-bg)" />
      <path
        d="M7.5 16h4l2.1-5.2 4.1 10.4 2.2-5.2h4.6"
        stroke="#07100C"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24.5" cy="16" r="1.5" fill="#07100C" />
      <defs>
        <linearGradient id="brand-bg" x1="3" y1="2" x2="29" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B8FF62" />
          <stop offset="1" stopColor="#6BDA87" />
        </linearGradient>
      </defs>
    </svg>
  );
}
