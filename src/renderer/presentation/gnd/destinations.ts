import {
  BriefcaseBusiness,
  FolderKanban,
  House,
  MessageSquare,
  Settings2,
  UserRound,
} from 'lucide-react';

/** Every page the shell can show; the command palette (⌘K) lists them all. */
export const destinations = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'jobs', label: 'Jobs', icon: BriefcaseBusiness },
  { id: 'interviews', label: 'Interviews', icon: MessageSquare },
  { id: 'applications', label: 'Your applications', icon: FolderKanban },
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const;

export type Destination = (typeof destinations)[number]['id'];

/** The GND top bar shows these; the rest live in the name menu. */
export const primaryDestinations = ['home', 'jobs', 'interviews'] as const;
/** Profile and Your applications are one page; the menu calls it Profile. */
export const accountDestinations = ['profile', 'settings'] as const;
