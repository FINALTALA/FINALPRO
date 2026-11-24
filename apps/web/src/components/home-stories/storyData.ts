// VIA STORIES: six editorial entry points on the homepage. Static for now -
// the story pages and the weekly product selection come later.

export type HomeStory = {
  id: string;
  /** Translation keys: `${key}.cat` (label above) and `${key}.title`. */
  key: string;
  image: { src: string; width: number; height: number };
  /** object-position for the 3:4 crop. */
  focus: string;
};

const dir = "/images/home-stories";

export const HOME_STORIES: HomeStory[] = [
  { id: "denim", key: "hst.denim", image: { src: `${dir}/denim.jpg`, width: 635, height: 900 }, focus: "50% 0%" },
  { id: "bags", key: "hst.bags", image: { src: `${dir}/bags.jpg`, width: 736, height: 1113 }, focus: "50% 45%" },
  { id: "shoes", key: "hst.shoes", image: { src: `${dir}/shoes.png`, width: 1122, height: 1402 }, focus: "65% 50%" },
  { id: "just-in", key: "hst.new", image: { src: `${dir}/just-in.jpg`, width: 736, height: 1307 }, focus: "50% 30%" },
  { id: "essentials", key: "hst.essentials", image: { src: `${dir}/essentials.png`, width: 735, height: 1103 }, focus: "50% 50%" },
  { id: "most-loved", key: "hst.loved", image: { src: `${dir}/most-loved.jpg`, width: 735, height: 914 }, focus: "50% 40%" },
];
