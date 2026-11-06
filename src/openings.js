(function (global) {
  'use strict';
  // Every line is a legal sequence from the standard start position in UCI
  // coordinate notation. Lines may be shallow; they exist to leave the engine
  // on ground it has already chosen, never to replace the search.
  const repertoire = [
    { id: 'none', name: 'Engine chooses', side: 'any', lines: [] },

    // ------------------------------------------------------------ white
    { id: 'italian', name: 'Italian Game', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4',
      'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3 e8g8'
    ] },
    { id: 'kings-gambit', name: 'King’s Gambit', side: 'w', lines: [
      'e2e4 e7e5 f2f4 e5f4 g1f3 g7g5 h2h4 g5g4 f3g5',
      'e2e4 e7e5 f2f4 f8c5 g1f3 d7d6 c2c3 g8f6 d2d4'
    ] },
    { id: 'queens-gambit', name: 'Queen’s Gambit', side: 'w', lines: [
      'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8',
      'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4',
      'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 c1g5'
    ] },
    { id: 'evans', name: 'Evans Gambit', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4 c5b4 c2c3 b4a5 d2d4',
      'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4 c5b4 c2c3 b4c3 d2c3'
    ] },
    { id: 'danish', name: 'Danish Gambit', side: 'w', lines: [
      'e2e4 e7e5 d2d4 e5d4 c2c3 d4c3 f1c4 c3b2 c1b2',
      'e2e4 e7e5 d2d4 e5d4 c2c3 d7d5 e4d5 d8d5 c3d4'
    ] },
    { id: 'smith-morra', name: 'Smith–Morra Gambit', side: 'w', lines: [
      'e2e4 c7c5 d2d4 c5d4 c2c3 d4c3 b1c3 b8c6 g1f3 g7g6 f1c4 f8g7',
      'e2e4 c7c5 d2d4 c5d4 c2c3 d4c3 b1c3 d7d6 g1f3 g8f6 f1c4'
    ] },
    { id: 'london', name: 'London System', side: 'w', lines: [
      'd2d4 d7d5 c1f4 g8f6 e2e3 e7e6 g1f3 f8e7 c2c3 e8g8',
      'd2d4 g8f6 c1f4 d7d5 e2e3 c7c5 c2c3 b8c6 g1f3'
    ] },
    { id: 'vienna', name: 'Vienna Game', side: 'w', lines: [
      'e2e4 e7e5 b1c3 g8f6 f2f4 d7d5 f4e5 f6e4 g1f3',
      'e2e4 e7e5 b1c3 b8c6 g1f3 g8f6 f1b5 f8b4'
    ] },
    { id: 'scotch', name: 'Scotch Game', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 b1c3 f8b4',
      'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 f8c5 c1e3 d8f6'
    ] },
    { id: 'ruy-lopez', name: 'Ruy López', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8',
      'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5c6 d7c6 e1g1 f7f6 d2d4'
    ] },
    { id: 'bishops-opening', name: 'Bishop’s Opening', side: 'w', lines: [
      'e2e4 e7e5 f1c4 g8f6 d2d3 f8c5 g1f3 d7d6 c2c3',
      'e2e4 e7e5 f1c4 b8c6 g1f3 f8c5 c2c3 g8f6 d2d4'
    ] },
    { id: 'four-knights', name: 'Four Knights Game', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1 e8g8 d2d3 d7d6'
    ] },
    { id: 'english', name: 'English Opening', side: 'w', lines: [
      'c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6 g1f3 b8c6',
      'c2c4 g8f6 b1c3 e7e6 g1f3 d7d5 d2d4 f8e7 c1f4 e8g8'
    ] },
    { id: 'catalan', name: 'Catalan Opening', side: 'w', lines: [
      'd2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 f8e7 g1f3 e8g8 e1g1'
    ] },
    { id: 'trompowsky', name: 'Trompowsky Attack', side: 'w', lines: [
      'd2d4 g8f6 c1g5 e7e6 e2e3 h7h6 g5f6 d8f6 b1c3 d7d6'
    ] },
    { id: 'colle', name: 'Colle System', side: 'w', lines: [
      'd2d4 d7d5 g1f3 g8f6 e2e3 e7e6 f1d3 c7c5 b1d2 b8c6 c2c3'
    ] },
    { id: 'kings-indian-attack', name: 'King’s Indian Attack', side: 'w', lines: [
      'e2e4 d7d5 d2d3 g8f6 b1d2 e7e5 g1f3 b8c6 g2g3 f8e7 f1g2 e8g8'
    ] },
    { id: 'birds', name: 'Bird’s Opening', side: 'w', lines: [
      'f2f4 d7d5 g1f3 g8f6 e2e3 c7c5 f1e2 b8c6 e1g1',
      'f2f4 d7d5 e2e3 g8f6 g1f3 e7e6 f1e2 f8e7 e1g1'
    ] },
    { id: 'nimzo-larsen', name: 'Nimzo–Larsen Attack', side: 'w', lines: [
      'b2b3 d7d5 c1b2 g8f6 e2e3 e7e6 g1f3 f8e7 c2c4 e8g8',
      'b2b3 e7e5 c1b2 b8c6 e2e3 g8f6 f1b5 d7d6 g1f3'
    ] },
    { id: 'blackmar-diemer', name: 'Blackmar–Diemer Gambit', side: 'w', lines: [
      'd2d4 d7d5 e2e4 d5e4 b1c3 g8f6 f2f3 e4f3 g1f3 e7e6 f1d3'
    ] },
    { id: 'goring', name: 'Göring Gambit', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 c2c3 d4c3 b1c3 f8b4 f1c4'
    ] },
    { id: 'halloween', name: 'Halloween Gambit', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 f3e5 c6e5 d2d4 e5c6 e4e5'
    ] },
    { id: 'alapin', name: 'Alapin Sicilian', side: 'w', lines: [
      'e2e4 c7c5 c2c3 g8f6 e4e5 f6d5 d2d4 c5d4 g1f3 b8c6 c3d4'
    ] },
    { id: 'grand-prix', name: 'Grand Prix Attack', side: 'w', lines: [
      'e2e4 c7c5 b1c3 b8c6 f2f4 g7g6 g1f3 f8g7 f1c4 e7e6'
    ] },
    { id: 'ponziani', name: 'Ponziani Opening', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 c2c3 g8f6 d2d4 f6e4 f1d3 d7d5'
    ] },
    { id: 'center-game', name: 'Center Game', side: 'w', lines: [
      'e2e4 e7e5 d2d4 e5d4 d1d4 b8c6 d4e3 g8f6 b1c3 f8b4'
    ] },
    { id: 'fried-liver', name: 'Fried Liver Attack', side: 'w', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7 e8f7 d1f3 f7e6 b1c3'
    ] },
    { id: 'benko-white', name: 'Benko Gambit Accepted', side: 'w', lines: [
      'd2d4 g8f6 c2c4 c7c5 d4d5 b7b5 c4b5 a7a6 b5a6 c8a6 b1c3 d7d6'
    ] },
    { id: 'polish', name: 'Polish Opening', side: 'w', lines: [
      'b2b4 e7e5 c1b2 f8b4 b2e5 g8f6 g1f3'
    ] },
    { id: 'van-geet', name: 'Van Geet Opening', side: 'w', lines: [
      'b1c3 d7d5 e2e4 d5e4 c3e4 b8c6 g1f3 g8f6'
    ] },
    { id: 'bishop-gambit', name: 'Bishop’s Gambit', side: 'w', lines: [
      'e2e4 e7e5 f2f4 e5f4 f1c4 d8h4 e1f1 d7d6 g1f3 h4e7'
    ] },

    // ------------------------------------------------------------ black
    { id: 'sicilian', name: 'Sicilian Defense', side: 'b', lines: [
      'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5',
      'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5 d4b5 d7d6',
      'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 b8c6 b1c3 d8c7 c1e3 a7a6'
    ] },
    { id: 'caro-kann', name: 'Caro–Kann Defense', side: 'b', lines: [
      'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6 h2h4 h7h6',
      'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5'
    ] },
    { id: 'scandinavian', name: 'Scandinavian Defense', side: 'b', lines: [
      'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5',
      'e2e4 d7d5 e4d5 g8f6 d2d4 f6d5 g1f3 c8g4 f1e2 e7e6'
    ] },
    { id: 'budapest', name: 'Budapest Gambit', side: 'b', lines: [
      'd2d4 g8f6 c2c4 e7e5 d4e5 f6g4 g1f3 b8c6 b1c3 f8b4'
    ] },
    { id: 'albin', name: 'Albin Countergambit', side: 'b', lines: [
      'd2d4 d7d5 c2c4 e7e5 d4e5 d5d4 g1f3 b8c6 b1d2 f8b4'
    ] },
    { id: 'french', name: 'French Defense', side: 'b', lines: [
      'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7 g5e7 d8e7',
      'e2e4 e7e6 d2d4 d7d5 e4d5 e6d5 g1f3 g8f6 f1d3 f8e7'
    ] },
    { id: 'french-winawer', name: 'French Winawer', side: 'b', lines: [
      'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3 b4c3 b2c3'
    ] },
    { id: 'kings-indian', name: 'King’s Indian Defense', side: 'b', lines: [
      'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5',
      'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5 e1g1 b8c6'
    ] },
    { id: 'nimzo-indian', name: 'Nimzo-Indian Defense', side: 'b', lines: [
      'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5 g1f3 c7c5'
    ] },
    { id: 'queens-indian', name: 'Queen’s Indian Defense', side: 'b', lines: [
      'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8b7 f1g2 f8b4'
    ] },
    { id: 'grunfeld', name: 'Grünfeld Defense', side: 'b', lines: [
      'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3 b2c3 f8g7'
    ] },
    { id: 'dutch', name: 'Dutch Defense', side: 'b', lines: [
      'd2d4 f7f5 g2g3 g8f6 f1g2 e7e6 g1f3 f8e7 e1g1 e8g8',
      'd2d4 f7f5 c2c4 g8f6 b1c3 e7e6 g1f3 f8b4'
    ] },
    { id: 'dutch-leningrad', name: 'Dutch Leningrad', side: 'b', lines: [
      'd2d4 f7f5 g2g3 g8f6 f1g2 g7g6 g1f3 f8g7 e1g1 e8g8'
    ] },
    { id: 'slav', name: 'Slav Defense', side: 'b', lines: [
      'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5'
    ] },
    { id: 'semi-slav', name: 'Semi-Slav Defense', side: 'b', lines: [
      'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 c1g5 h7h6 g5f6 d8f6'
    ] },
    { id: 'benoni', name: 'Benoni Defense', side: 'b', lines: [
      'd2d4 g8f6 c2c4 c7c5 d4d5 e7e6 b1c3 e6d5 c4d5 d7d6 e2e4 g7g6'
    ] },
    { id: 'benko', name: 'Benko Gambit', side: 'b', lines: [
      'd2d4 g8f6 c2c4 c7c5 d4d5 b7b5 c4b5 a7a6 b5a6 c8a6 b1c3 d7d6'
    ] },
    { id: 'pirc', name: 'Pirc Defense', side: 'b', lines: [
      'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2 e8g8',
      'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 f2f4 f8g7 g1f3 e8g8'
    ] },
    { id: 'modern', name: 'Modern Defense', side: 'b', lines: [
      'e2e4 g7g6 d2d4 f8g7 b1c3 d7d6 g1f3 g8f6 f1e2 e8g8'
    ] },
    { id: 'alekhine', name: 'Alekhine Defense', side: 'b', lines: [
      'e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 d6e5 f3e5 c8f5'
    ] },
    { id: 'petrov', name: 'Petrov Defense', side: 'b', lines: [
      'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5 f1d3 c8e6'
    ] },
    { id: 'philidor', name: 'Philidor Defense', side: 'b', lines: [
      'e2e4 e7e5 g1f3 d7d6 d2d4 g8f6 b1c3 b8d7 f1c4 f8e7'
    ] },
    { id: 'berlin', name: 'Berlin Defense', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1b5 g8f6 e1g1 f6e4 d2d4 e4d6 b5c6 d7c6'
    ] },
    { id: 'marshall', name: 'Marshall Attack', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 e8g8 c2c3 d7d5 e4d5 f6d5'
    ] },
    { id: 'two-knights', name: 'Two Knights Defense', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3 d7d6',
      'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 c6a5'
    ] },
    { id: 'traxler', name: 'Traxler Counterattack', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 f8c5 g5f7 c5f2 e1f2 f6e4 f2e1 d8h4'
    ] },
    { id: 'englund', name: 'Englund Gambit', side: 'b', lines: [
      'd2d4 e7e5 d4e5 b8c6 g1f3 d8e7 c1f4 e7b4 b1d2 b4b2'
    ] },
    { id: 'elephant', name: 'Elephant Gambit', side: 'b', lines: [
      'e2e4 e7e5 g1f3 d7d5 e4d5 e5e4 d1e2 g8f6 d2d3 d8d5',
      'e2e4 e7e5 g1f3 d7d5 e4d5 e5e4 d1e2 d8d5 b1c3 d5a5'
    ] },
    { id: 'latvian', name: 'Latvian Gambit', side: 'b', lines: [
      'e2e4 e7e5 g1f3 f7f5 e4f5 e5e4 f3g5 g8f6'
    ] },
    { id: 'falkbeer', name: 'Falkbeer Countergambit', side: 'b', lines: [
      'e2e4 e7e5 f2f4 d7d5 e4d5 e5e4 d2d3 g8f6 d3e4 f6e4'
    ] },
    { id: 'from', name: 'From’s Gambit', side: 'b', lines: [
      'f2f4 e7e5 f4e5 d7d6 e5d6 f8d6 g1f3 g7g5'
    ] },
    { id: 'qga', name: 'Queen’s Gambit Accepted', side: 'b', lines: [
      'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5'
    ] },
    { id: 'qgd', name: 'Queen’s Gambit Declined', side: 'b', lines: [
      'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8'
    ] },
    { id: 'tarrasch', name: 'Tarrasch Defense', side: 'b', lines: [
      'd2d4 d7d5 c2c4 e7e6 b1c3 c7c5 c4d5 e6d5 g1f3 b8c6'
    ] },
    { id: 'chigorin', name: 'Chigorin Defense', side: 'b', lines: [
      'd2d4 d7d5 c2c4 b8c6 g1f3 c8g4 c4d5 g4f3 g2f3 d8d5'
    ] },
    { id: 'vienna-black', name: 'Vienna Game (Black)', side: 'b', lines: [
      'e2e4 e7e5 b1c3 g8f6 f2f4 d7d5 f4e5 f6e4 g1f3 f8e7'
    ] },
    { id: 'italian-black', name: 'Giuoco Piano (Black)', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6'
    ] },
    { id: 'four-knights-black', name: 'Four Knights (Black)', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1 e8g8 d2d3 d7d6'
    ] },
    { id: 'scotch-black', name: 'Scotch Game (Black)', side: 'b', lines: [
      'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 f8c5 c1e3 d8f6 c2c3 g8e7'
    ] },
    { id: 'kings-gambit-black', name: 'King’s Gambit Accepted', side: 'b', lines: [
      'e2e4 e7e5 f2f4 e5f4 g1f3 g7g5 h2h4 g5g4 f3g5 d7d5',
      'e2e4 e7e5 f2f4 e5f4 g1f3 d7d6 d2d4 g7g5'
    ] },
    { id: 'sicilian-dragon', name: 'Sicilian Dragon', side: 'b', lines: [
      'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6 f1e2 f8g7'
    ] },
    { id: 'sicilian-classical', name: 'Sicilian Classical', side: 'b', lines: [
      'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 b8c6 c1e3 e7e6'
    ] },
    { id: 'sicilian-scheveningen', name: 'Sicilian Scheveningen', side: 'b', lines: [
      'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e6 c1e3 a7a6'
    ] },

    { id: 'custom', name: 'Custom line', side: 'any', lines: [] }
  ];
  // The own-games book is only offered when a book has actually been built.
  // It reads src/book-data.js, generated from this engine's own self-play by
  // scripts/build-book.js, and repeats only moves the engine chose itself.
  // A menu entry with no data behind it would silently do nothing, so the
  // entry appears only when the data exists.
  if (global.NyxBookData) {
    repertoire.push({ id: 'own-games', name: 'Own games (book)', side: 'any', lines: [] });
  }
  const cache = new Map();
  function compile(text) {
    const { Position, START_FEN, uci, positionKey } = global.NyxChess;
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 80) throw new Error('Custom lines support up to 80 half-moves.');
    const position = new Position(START_FEN);
    const entries = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const move = position.legalMoves().find((candidate) => uci(candidate) === token);
      if (!move) throw new Error(`Illegal opening move ${i + 1}: ${tokens[i]}. Use coordinate notation, e.g. e2e4.`);
      entries.push([positionKey(position.fen()), { move: token, encoded: move, turn: position.side === 1 ? 'w' : 'b', ply: i + 1 }]);
      position.make(move);
    }
    return entries;
  }
  function validate(text) {
    try { const entries = compile(text); return { ok: true, plies: entries.length }; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  // Custom lines are stored per side so a White repertoire and a Black
  // repertoire can coexist. The old shared `customLine` key still works for
  // saved settings and for callers that prefer one line for both colors.
  function customText(options, turn, id) {
    const own = turn === 'w' ? options.customLineWhite : options.customLineBlack;
    if (typeof own === 'string' && own.trim()) return own;
    if (id === 'custom' && typeof options.customLine === 'string') return options.customLine;
    return '';
  }
  // Own-games book. The data says only "in this position the engine played
  // this move N times and scored S"; it is a record of this engine's play, not
  // an imported line. Missing data is not an error — the caller falls through
  // to the search, which is the same thing as the book running out.
  function bookPick(fen, opening, options) {
    const data = global.NyxBookData;
    if (!data) return null;
    const entries = data[global.NyxChess.positionKey(fen)];
    if (!Array.isArray(entries) || !entries.length) return null;
    const position = new global.NyxChess.Position(fen);
    const legal = new Set(position.legalMoves().map((move) => global.NyxChess.uci(move)));
    // Weight by how often the move was played and how well it scored, so a
    // move that won most of its games is preferred to one that got lucky once.
    const weighted = [];
    let total = 0;
    for (const entry of entries) {
      const move = entry[0];
      if (!legal.has(move)) continue;
      const weight = Math.max(0.5, Number(entry[1]) || 0) * (0.35 + (Number(entry[2]) || 0));
      if (!(weight > 0)) continue;
      weighted.push({ move, weight });
      total += weight;
    }
    if (!weighted.length) return null;
    // The seed is mixed with the move number so White's and Black's picks in
    // the same game do not come from the same roll.
    const seed = Number(options.bookSeed);
    const roll = Number.isFinite(seed)
      ? ((Math.imul((seed + position.full) | 0, 0x9e3779b1) >>> 0) / 0x100000000)
      : Math.random();
    let chosen = weighted[weighted.length - 1];
    let cursor = roll * total;
    for (const item of weighted) {
      cursor -= item.weight;
      if (cursor <= 0) { chosen = item; break; }
    }
    const encoded = position.legalMoves().find((move) => global.NyxChess.uci(move) === chosen.move);
    if (!encoded) return null;
    return { best: encoded, move: chosen.move, score: null, mate: null,
      source: 'book', opening: opening.name, depth: 0, nodes: 0, time: 0, ply: position.full };
  }
  function pick(fen, options = {}) {
    const turn = fen.split(' ')[1];
    const id = options[turn === 'w' ? 'openingWhite' : 'openingBlack'] || 'none';
    const opening = repertoire.find((item) => item.id === id);
    if (!opening || id === 'none' || (opening.side !== 'any' && opening.side !== turn)) return null;
    const text = customText(options, turn, id);
    if (id === 'custom' && !text.trim()) return null;
    if (id === 'own-games') {
      const fromBook = bookPick(fen, opening, options);
      if (fromBook) return fromBook;
      return null;
    }
    const key = id + ':' + (id === 'custom' ? text : '');
    if (!cache.has(key)) {
      const map = new Map();
      for (const line of id === 'custom' ? [text] : opening.lines) {
        for (const [position, entry] of compile(line)) {
          if (!map.has(position)) map.set(position, []);
          if (!map.get(position).some((item) => item.move === entry.move)) map.get(position).push(entry);
        }
      }
      if (cache.size > 64) cache.clear();
      cache.set(key, map);
    }
    const candidates = cache.get(key).get(global.NyxChess.positionKey(fen));
    if (!candidates?.length) return null;
    // A caller-provided seed makes opening choice reproducible across a worker
    // boundary while still rotating lines between games.
    const seed = Number(options.bookSeed);
    const roll = Number.isFinite(seed)
      ? ((Math.imul(seed | 0, 0x9e3779b1) >>> 0) / 0x100000000)
      : Math.random();
    const candidate = candidates[Math.floor(roll * candidates.length)];
    const position = new global.NyxChess.Position(fen);
    if (!position.legalMoves().includes(candidate.encoded)) return null;
    return { best: candidate.encoded, move: candidate.move, score: null, mate: null,
      source: 'book', opening: opening.name, depth: 0, nodes: 0, time: 0, ply: candidate.ply };
  }
  global.NyxOpenings = { repertoire, compile, validate, pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NyxOpenings;
})(globalThis);
