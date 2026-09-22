import React from "react";
const P = (d) => (props) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{d}</svg>
);
export const CalendarIcon = P(<><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>);
export const WalletIcon = P(<><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="3.5" y="7.5" width="17" height="12" rx="3" /><circle cx="16.5" cy="13.5" r="1.1" fill="currentColor" /></>);
export const BellIcon = P(<><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>);
export const ShieldIcon = P(<><path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6l7-2.5Z" /><path d="m9 12 2.2 2.2L15.2 10" /></>);
export const SunIcon = P(<><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>);
export const MoonIcon = P(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />);
export const CopyIcon = P(<><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></>);
export const PlusIcon = P(<path d="M12 5v14M5 12h14" />);
export const ChevronLeftIcon = P(<path d="m14.5 6-6 6 6 6" />);
export const ChevronRightIcon = P(<path d="m9.5 6 6 6-6 6" />);
export const CloseIcon = P(<path d="M6 6l12 12M18 6 6 18" />);
