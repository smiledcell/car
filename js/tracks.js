// APEX FORMULA 2026 track data. This classic-script file is the single runtime source
// for both direct file:// launches and HTTP launches.
(() => {
  const rows = [
    ['australia','Albert Park Circuit','阿尔伯特公园赛道','AUS',5.278,'park',false],
    ['china','Shanghai International Circuit','上海国际赛车场','CHN',5.451,'modern',false],
    ['japan','Suzuka International Racing Course','铃鹿赛道','JPN',5.807,'figure8',false],
    ['bahrain','Bahrain International Circuit','巴林国际赛车场','BHR',5.412,'desert',true],
    ['jeddah','Jeddah Corniche Circuit','吉达滨海赛道','SAU',6.174,'street',true],
    ['miami','Miami International Autodrome','迈阿密国际赛车场','USA',5.412,'street',false],
    ['canada','Circuit Gilles-Villeneuve','吉尔·维伦纽夫赛道','CAN',4.361,'park',false],
    ['monaco','Circuit de Monaco','摩纳哥赛道','MCO',3.337,'street',false],
    ['spain','Circuit de Barcelona-Catalunya','巴塞罗那-加泰罗尼亚赛道','ESP',4.657,'modern',false],
    ['austria','Red Bull Ring','红牛环赛道','AUT',4.318,'hills',false],
    ['britain','Silverstone Circuit','银石赛道','GBR',5.891,'fast',false],
    ['belgium','Circuit de Spa-Francorchamps','斯帕-弗朗科尔尚赛道','BEL',7.004,'hills',false],
    ['hungary','Hungaroring','匈格罗宁赛道','HUN',4.381,'twisty',false],
    ['netherlands','Circuit Zandvoort','赞德沃特赛道','NLD',4.259,'dunes',false],
    ['italy','Autodromo Nazionale Monza','蒙扎国家赛车场','ITA',5.793,'fast',false],
    ['madrid','Madring','马德里赛道','ESP',5.416,'street',false],
    ['azerbaijan','Baku City Circuit','巴库城市赛道','AZE',6.003,'street',false],
    ['singapore','Marina Bay Street Circuit','滨海湾街道赛道','SGP',4.940,'street',true],
    ['austin','Circuit of the Americas','美洲赛道','USA',5.513,'hills',false],
    ['mexico','Autodromo Hermanos Rodriguez','墨西哥城赛道','MEX',4.304,'modern',false],
    ['brazil','Interlagos / Autodromo Jose Carlos Pace','英特拉格斯赛道','BRA',4.309,'hills',false],
    ['lasvegas','Las Vegas Strip Circuit','拉斯维加斯大道赛道','USA',6.201,'street',true],
    ['qatar','Lusail International Circuit','卢赛尔国际赛车场','QAT',5.419,'fast',true],
    ['abu-dhabi','Yas Marina Circuit','亚斯码头赛道','ARE',5.281,'modern',true],
  ].map(([id,en,zh,country,lengthKm,style,night], round) => ({
    id, en, zh, country, lengthKm, style, night, round: round + 1,
    source: '2026 calendar reference; simplified original geometry',
    layoutStatus: id === 'madrid' ? 'provisional' : 'simplified',
  }));

  const profiles = {
    park:[[-1,-.55],[-.45,-.75],[.35,-.7],[.75,-.35],[.7,.2],[.3,.65],[-.35,.72],[-.8,.4]],
    modern:[[-1,-.6],[.2,-.7],[.82,-.4],[.7,.05],[.35,.5],[-.35,.65],[-.9,.35]],
    street:[[-1,-.5],[.1,-.58],[.82,-.25],[.72,.25],[.25,.62],[-.55,.58],[-.85,.15]],
    fast:[[-1,-.62],[.9,-.55],[.95,-.12],[.45,.55],[-.2,.7],[-.85,.45]],
    hills:[[-1,-.55],[-.15,-.78],[.8,-.4],[.85,.25],[.2,.72],[-.6,.62],[-.85,.12]],
    twisty:[[-1,-.45],[-.55,-.72],[.05,-.5],[.75,-.65],[.9,-.05],[.5,.55],[-.15,.65],[-.75,.42]],
    dunes:[[-1,-.5],[.15,-.72],[.85,-.3],[.65,.35],[.1,.68],[-.7,.55]],
    figure8:[[-1,-.42],[-.35,-.7],[.45,-.55],[.85,-.15],[.35,.05],[.82,.35],[.3,.7],[-.4,.62],[-.85,.25],[-.3,.05]],
    desert:[[-1,-.5],[-.2,-.72],[.8,-.45],[.85,.1],[.35,.65],[-.55,.58],[-.85,.05]],
  };
  const controlPoints = track => (profiles[track.style] || profiles.modern).map(([x,z], i) => ({
    x: x * (track.style === 'street' ? 150 : 170),
    z: z * (track.style === 'fast' ? 115 : 135),
    y: track.style === 'hills' ? Math.sin(i * 1.7) * 2.5 : 0,
  }));
  const aliases = { spa: 'belgium', vegas: 'lasvegas' };
  window.APEX_TRACKS = {
    TRACKS: rows,
    DEFAULT_TRACK: 'lasvegas',
    controlPoints,
    trackById: id => rows.find(t => t.id === (aliases[id] || id)) || rows[0],
  };
})();
