const MOVIE_BASE_URL = "https://srvnexium.me/series/0607461203/7844293931/";
const MOVIE_START = 100026;
const MOVIE_END = 400028;
const MOVIE_CATEGORY = "Filmes";

function movieId(number) {
  return `filme-${number}`;
}

function movieUrl(number) {
  return `${MOVIE_BASE_URL}${number}.mp4`;
}

function movieChannel(number) {
  return {
    id: movieId(number),
    name: `Filme ${number}`,
    category: MOVIE_CATEGORY,
    url: movieUrl(number),
    mode: "mp4"
  };
}

function getGeneratedMovieCount() {
  return MOVIE_END - MOVIE_START + 1;
}

function isGeneratedMovieId(id) {
  const match = String(id || "").match(/^filme-(\d+)$/);
  if (!match) return false;

  const number = Number(match[1]);
  return Number.isInteger(number) && number >= MOVIE_START && number <= MOVIE_END;
}

function findGeneratedMovieById(id) {
  if (!isGeneratedMovieId(id)) return null;
  const number = Number(String(id).replace("filme-", ""));
  return movieChannel(number);
}

function readGeneratedMovies() {
  const movies = [];
  for (let number = MOVIE_START; number <= MOVIE_END; number++) {
    movies.push(movieChannel(number));
  }
  return movies;
}

module.exports = {
  findGeneratedMovieById,
  getGeneratedMovieCount,
  readGeneratedMovies
};
