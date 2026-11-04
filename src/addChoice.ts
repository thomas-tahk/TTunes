// How a newly added track enters playback. Every add path (YouTube link, dropped
// file, typed search) ends in one of these three choices.
export type AddChoice = "now" | "next" | "last";
