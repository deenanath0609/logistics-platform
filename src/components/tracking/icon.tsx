"use client";

import {
  AlertTriangle,
  Building2,
  CircleDot,
  Gauge,
  MapPin,
  Navigation,
  PhoneCall,
  Radio,
  RadioTower,
  Route,
  Satellite,
  SignalHigh,
  SignalZero,
  Timer,
  Truck,
  Warehouse,
  type LucideProps,
} from "lucide-react";

/**
 * Icons by name.
 *
 * A Lucide icon is a function component, and a function cannot cross the
 * server/client boundary — passing one from a server component throws at
 * serialisation time, and it throws at render, not at build, which makes it
 * an error the type system will not catch for you. So server components
 * pass a name and this maps it here, on the client, where the component
 * actually exists.
 */
export const TRACKING_ICONS = {
  alert: AlertTriangle,
  branch: Building2,
  fix: CircleDot,
  hub: Warehouse,
  manual: PhoneCall,
  office: Building2,
  pin: MapPin,
  provider: RadioTower,
  radio: Radio,
  route: Route,
  satellite: Satellite,
  signal: SignalHigh,
  silent: SignalZero,
  speed: Gauge,
  timer: Timer,
  truck: Truck,
  vehicle: Navigation,
} as const;

export type TrackingIconName = keyof typeof TRACKING_ICONS;

export function TrackingIcon({
  name,
  ...props
}: { name: TrackingIconName } & LucideProps) {
  const Component = TRACKING_ICONS[name] ?? CircleDot;
  return <Component {...props} />;
}
