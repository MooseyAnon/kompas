import {
  BriefcaseBusiness,
  House,
  Mic,
  Settings2,
  UserRound,
} from 'lucide-react';

export const destinations = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'jobs', label: 'Jobs', icon: BriefcaseBusiness },
  { id: 'interviews', label: 'Interviews', icon: Mic },
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const;

export type Destination = (typeof destinations)[number]['id'];
