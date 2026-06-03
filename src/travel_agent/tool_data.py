from __future__ import annotations

WEATHER_CODES = {
    0: "晴朗",
    1: "主要晴朗",
    2: "部分多云",
    3: "阴天",
    45: "雾",
    48: "雾凇",
    51: "毛毛雨",
    53: "中度毛毛雨",
    55: "强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    95: "雷雨",
    96: "雷雨伴冰雹",
    99: "强雷雨伴冰雹",
}


AIRPORT_IATA_BY_CITY = {
    # 直辖市 / 省会
    "北京": "PEK", "北京首都": "PEK", "大兴": "PKX",
    "上海": "SHA", "上海虹桥": "SHA", "上海浦东": "PVG",
    "广州": "CAN", "深圳": "SZX",
    "成都": "TFU", "成都天府": "TFU", "成都双流": "CTU",
    "重庆": "CKG",
    "杭州": "HGH", "宁波": "NGB",
    "郑州": "CGO", "南京": "NKG", "武汉": "WUH", "长沙": "CSX",
    "西安": "XIY", "昆明": "KMG", "厦门": "XMN", "青岛": "TAO",
    "天津": "TSN", "济南": "TNA", "福州": "FOC",
    "三亚": "SYX", "海口": "HAK",
    "哈尔滨": "HRB", "沈阳": "SHE", "大连": "DLC",
    "乌鲁木齐": "URC", "贵阳": "KWE", "南宁": "NNG",
    "太原": "TYN", "兰州": "LHW", "呼和浩特": "HET",
    "长春": "CGQ", "拉萨": "LXA", "银川": "INC",
    "西宁": "XNN", "合肥": "HFE", "南昌": "KHN", "石家庄": "SJW",
    # 热门旅游城市
    "桂林": "KWL", "张家界": "DYG", "丽江": "LJG",
    "西双版纳": "JHG", "大理": "DLU", "腾冲": "TCZ",
    "敦煌": "DNH", "嘉峪关": "JGN", "延安": "ENY",
    "武夷山": "WUS", "黄山": "TXN", "秦皇岛": "BPE",
    "林芝": "LZY", "日喀则": "RKZ", "漠河": "OHE",
    "阿尔山": "YIE", "满洲里": "NZH",
    # 江苏
    "无锡": "WUX", "常州": "CZX", "徐州": "XUZ", "扬州": "YTY",
    "南通": "NTG", "连云港": "LYG", "盐城": "YNZ", "淮安": "HIA",
    # 浙江
    "温州": "WNZ", "义乌": "YIW", "舟山": "HSN", "台州": "HYN",
    "衢州": "JUZ",
    # 福建
    "泉州": "JJN", "三明": "SQJ", "连城": "LCX",
    # 广东
    "珠海": "ZUH", "揭阳": "SWA", "湛江": "ZHA", "惠州": "HUZ",
    "梅州": "MXZ", "佛山": "FUO",
    # 山东
    "烟台": "YNT", "威海": "WEH", "临沂": "LYI", "潍坊": "WEF",
    "日照": "RIZ", "济宁": "JNG", "东营": "DOY",
    # 河南
    "洛阳": "LYA", "南阳": "NNY", "信阳": "XAI",
    # 湖北
    "宜昌": "YIH", "襄阳": "XFN", "十堰": "WDS", "恩施": "ENH",
    "荆州": "SHS", "神农架": "HPG",
    # 湖南
    "衡阳": "HNY", "岳阳": "YYA", "常德": "CGD", "怀化": "HJJ",
    "永州": "LLF",
    # 广西
    "北海": "BHY", "柳州": "LZH", "梧州": "WUZ", "百色": "AEB",
    "玉林": "YLX",
    # 四川
    "绵阳": "MIG", "泸州": "LZO", "宜宾": "YBP", "南充": "NAO",
    "达州": "DAX", "西昌": "XIC",
    # 重庆辖区
    "万州": "WXN", "黔江": "JIQ",
    # 贵州
    "遵义": "ZYI", "铜仁": "TEN", "兴义": "ACX", "安顺": "AVA",
    "毕节": "BFJ", "六盘水": "LPF",
    # 云南
    "保山": "BSD", "芒市": "LUM", "普洱": "SYM", "临沧": "LNJ",
    "文山": "WNH", "昭通": "ZAT", "迪庆": "DIG",
    # 西藏
    "昌都": "BPX", "阿里": "NGQ",
    # 新疆
    "喀什": "KHG", "库尔勒": "KRL", "和田": "HTN", "阿克苏": "AKU",
    "克拉玛依": "KRY", "哈密": "HMI", "阿勒泰": "AAT",
    "伊宁": "YIN", "吐鲁番": "TLQ", "博乐": "BPL", "塔城": "TCG",
    "富蕴": "FYN", "那拉提": "NLT",
    # 青海
    "格尔木": "GOQ", "玉树": "YUS", "果洛": "GMQ",
    # 甘肃
    "天水": "THQ", "庆阳": "IQN", "陇南": "LNL", "金昌": "JIC",
    "张掖": "YZY",
    # 宁夏
    "固原": "GYU", "中卫": "ZHY",
    # 陕西
    "榆林": "UYN", "安康": "AKA", "汉中": "HZG",
    # 山西
    "运城": "YCU", "大同": "DAT", "长治": "CIH",
    # 河北
    "邯郸": "HDG", "唐山": "TVS", "张家口": "ZQZ", "承德": "CDE",
    # 内蒙古
    "包头": "BAV", "赤峰": "CIF", "通辽": "TGO", "鄂尔多斯": "DSN",
    "乌海": "WUA", "海拉尔": "HLD", "乌兰浩特": "HLH",
    "锡林浩特": "XIL", "巴彦淖尔": "RLK",
    # 辽宁
    "锦州": "JNZ", "丹东": "DDG", "营口": "YKH", "鞍山": "AOG",
    "朝阳": "CHG",
    # 吉林
    "延吉": "YNJ", "通化": "TNH", "白城": "DBC", "松原": "YSQ",
    # 黑龙江
    "佳木斯": "JMU", "齐齐哈尔": "NDG", "牡丹江": "MDG",
    "大庆": "DQA", "黑河": "HEK", "伊春": "LDS", "鸡西": "JXA",
    "抚远": "FYJ",
    # 江西
    "景德镇": "JDZ", "赣州": "KOW", "宜春": "YIC", "吉安": "JGS",
    "上饶": "SQD", "九江": "JIU",
    # 安徽
    "安庆": "AQG", "阜阳": "FUG", "池州": "JUH",
    # 海南
    "琼海": "BAR",
}


HOTEL_CITY_ALIASES = {
    # 直辖市 / 省会
    "北京": "Beijing", "上海": "Shanghai", "广州": "Guangzhou",
    "深圳": "Shenzhen", "成都": "Chengdu", "重庆": "Chongqing",
    "杭州": "Hangzhou", "宁波": "Ningbo", "郑州": "Zhengzhou",
    "西安": "Xi'an", "南京": "Nanjing", "武汉": "Wuhan",
    "长沙": "Changsha", "苏州": "Suzhou", "厦门": "Xiamen",
    "青岛": "Qingdao", "天津": "Tianjin", "昆明": "Kunming",
    "大理": "Dali", "丽江": "Lijiang", "三亚": "Sanya",
    "海口": "Haikou", "舟山": "Zhoushan",
    "济南": "Jinan", "福州": "Fuzhou", "沈阳": "Shenyang",
    "大连": "Dalian", "哈尔滨": "Harbin", "长春": "Changchun",
    "太原": "Taiyuan", "石家庄": "Shijiazhuang", "合肥": "Hefei",
    "南昌": "Nanchang", "贵阳": "Guiyang", "南宁": "Nanning",
    "兰州": "Lanzhou", "西宁": "Xining", "银川": "Yinchuan",
    "呼和浩特": "Hohhot", "乌鲁木齐": "Urumqi", "拉萨": "Lhasa",
    # 热门旅游城市
    "桂林": "Guilin", "张家界": "Zhangjiajie", "西双版纳": "Xishuangbanna",
    "腾冲": "Tengchong", "敦煌": "Dunhuang", "嘉峪关": "Jiayuguan",
    "延安": "Yan'an", "武夷山": "Wuyishan", "黄山": "Huangshan",
    "林芝": "Nyingchi", "日喀则": "Shigatse",
    "漠河": "Mohe", "阿尔山": "Arxan", "满洲里": "Manzhouli",
    "香格里拉": "Shangri-La", "稻城": "Daocheng",
    # 江苏
    "无锡": "Wuxi", "常州": "Changzhou", "徐州": "Xuzhou",
    "扬州": "Yangzhou", "南通": "Nantong", "连云港": "Lianyungang",
    "盐城": "Yancheng", "淮安": "Huai'an", "镇江": "Zhenjiang",
    "泰州": "Taizhou",
    # 浙江
    "温州": "Wenzhou", "义乌": "Yiwu", "台州": "Taizhou",
    "衢州": "Quzhou", "嘉兴": "Jiaxing", "湖州": "Huzhou",
    "绍兴": "Shaoxing", "金华": "Jinhua",
    # 福建
    "泉州": "Quanzhou", "三明": "Sanming", "漳州": "Zhangzhou",
    "莆田": "Putian", "龙岩": "Longyan", "宁德": "Ningde",
    # 广东
    "珠海": "Zhuhai", "揭阳": "Jieyang", "湛江": "Zhanjiang",
    "惠州": "Huizhou", "梅州": "Meizhou", "佛山": "Foshan",
    "东莞": "Dongguan", "中山": "Zhongshan", "江门": "Jiangmen",
    "肇庆": "Zhaoqing", "汕头": "Shantou", "潮州": "Chaozhou",
    "茂名": "Maoming", "韶关": "Shaoguan", "清远": "Qingyuan",
    # 山东
    "烟台": "Yantai", "威海": "Weihai", "临沂": "Linyi",
    "潍坊": "Weifang", "日照": "Rizhao", "济宁": "Jining",
    "东营": "Dongying", "淄博": "Zibo", "泰安": "Tai'an",
    "聊城": "Liaocheng", "德州": "Dezhou", "菏泽": "Heze",
    "枣庄": "Zaozhuang", "滨州": "Binzhou",
    # 河南
    "洛阳": "Luoyang", "南阳": "Nanyang", "信阳": "Xinyang",
    "开封": "Kaifeng", "安阳": "Anyang", "新乡": "Xinxiang",
    "许昌": "Xuchang", "商丘": "Shangqiu",
    # 湖北
    "宜昌": "Yichang", "襄阳": "Xiangyang", "十堰": "Shiyan",
    "恩施": "Enshi", "荆州": "Jingzhou", "神农架": "Shennongjia",
    "黄石": "Huangshi", "鄂州": "Ezhou",
    # 湖南
    "衡阳": "Hengyang", "岳阳": "Yueyang", "常德": "Changde",
    "怀化": "Huaihua", "永州": "Yongzhou", "株洲": "Zhuzhou",
    "湘潭": "Xiangtan", "郴州": "Chenzhou", "娄底": "Loudi",
    "邵阳": "Shaoyang", "益阳": "Yiyang",
    # 广西
    "北海": "Beihai", "柳州": "Liuzhou", "梧州": "Wuzhou",
    "百色": "Baise", "玉林": "Yulin", "桂林阳朔": "Yangshuo",
    "钦州": "Qinzhou", "防城港": "Fangchenggang",
    # 四川
    "绵阳": "Mianyang", "泸州": "Luzhou", "宜宾": "Yibin",
    "南充": "Nanchong", "达州": "Dazhou", "西昌": "Xichang",
    "乐山": "Leshan", "自贡": "Zigong", "德阳": "Deyang",
    "广元": "Guangyuan", "遂宁": "Suining", "内江": "Neijiang",
    "眉山": "Meishan", "雅安": "Ya'an", "攀枝花": "Panzhihua",
    # 重庆辖区
    "万州": "Wanzhou", "黔江": "Qianjiang",
    # 贵州
    "遵义": "Zunyi", "铜仁": "Tongren", "兴义": "Xingyi",
    "安顺": "Anshun", "毕节": "Bijie", "六盘水": "Liupanshui",
    "凯里": "Kaili", "都匀": "Duyun",
    # 云南
    "保山": "Baoshan", "芒市": "Mangshi", "普洱": "Pu'er",
    "临沧": "Lincang", "文山": "Wenshan", "昭通": "Zhaotong",
    "迪庆": "Diqing", "曲靖": "Qujing", "玉溪": "Yuxi",
    "楚雄": "Chuxiong", "红河": "Honghe", "德宏": "Dehong",
    # 西藏
    "昌都": "Qamdo", "阿里": "Ngari", "那曲": "Nagqu",
    "山南": "Shannan",
    # 新疆
    "喀什": "Kashgar", "库尔勒": "Korla", "和田": "Hotan",
    "阿克苏": "Aksu", "克拉玛依": "Karamay", "哈密": "Hami",
    "阿勒泰": "Altay", "伊宁": "Yining", "吐鲁番": "Turpan",
    "博乐": "Bole", "塔城": "Tacheng", "富蕴": "Fuyun",
    "那拉提": "Narat", "昌吉": "Changji", "石河子": "Shihezi",
    # 青海
    "格尔木": "Golmud", "玉树": "Yushu", "果洛": "Golog",
    "德令哈": "Delingha", "海东": "Haidong",
    # 甘肃
    "天水": "Tianshui", "庆阳": "Qingyang", "陇南": "Longnan",
    "金昌": "Jinchang", "张掖": "Zhangye", "酒泉": "Jiuquan",
    "平凉": "Pingliang", "白银": "Baiyin", "武威": "Wuwei",
    "定西": "Dingxi",
    # 宁夏
    "固原": "Guyuan", "中卫": "Zhongwei", "吴忠": "Wuzhong",
    "石嘴山": "Shizuishan",
    # 陕西
    "榆林": "Yulin", "安康": "Ankang", "汉中": "Hanzhong",
    "宝鸡": "Baoji", "咸阳": "Xianyang", "渭南": "Weinan",
    "商洛": "Shangluo",
    # 山西
    "大同": "Datong", "长治": "Changzhi", "运城": "Yuncheng",
    "临汾": "Linfen", "晋城": "Jincheng", "忻州": "Xinzhou",
    "吕梁": "Lvliang", "晋中": "Jinzhong",
    # 河北
    "邯郸": "Handan", "唐山": "Tangshan", "张家口": "Zhangjiakou",
    "承德": "Chengde", "秦皇岛": "Qinhuangdao", "保定": "Baoding",
    "廊坊": "Langfang", "沧州": "Cangzhou", "邢台": "Xingtai",
    "衡水": "Hengshui",
    # 内蒙古
    "包头": "Baotou", "赤峰": "Chifeng", "通辽": "Tongliao",
    "鄂尔多斯": "Ordos", "乌海": "Wuhai", "海拉尔": "Hailar",
    "乌兰浩特": "Ulanhot", "锡林浩特": "Xilinhot",
    "巴彦淖尔": "Bayannur", "呼伦贝尔": "Hulunbuir",
    "二连浩特": "Erenhot", "乌兰察布": "Ulanqab",
    # 辽宁
    "锦州": "Jinzhou", "丹东": "Dandong", "营口": "Yingkou",
    "鞍山": "Anshan", "朝阳": "Chaoyang", "盘锦": "Panjin",
    "抚顺": "Fushun", "本溪": "Benxi", "辽阳": "Liaoyang",
    "葫芦岛": "Huludao", "铁岭": "Tieling",
    # 吉林
    "延吉": "Yanji", "通化": "Tonghua", "白城": "Baicheng",
    "松原": "Songyuan", "四平": "Siping", "辽源": "Liaoyuan",
    "白山": "Baishan",
    # 黑龙江
    "佳木斯": "Jiamusi", "齐齐哈尔": "Qiqihar", "牡丹江": "Mudanjiang",
    "大庆": "Daqing", "黑河": "Heihe", "伊春": "Yichun",
    "鸡西": "Jixi", "抚远": "Fuyuan", "鹤岗": "Hegang",
    "双鸭山": "Shuangyashan", "绥化": "Suihua", "七台河": "Qitaihe",
    "大兴安岭": "Daxing'anling",
    # 江西
    "景德镇": "Jingdezhen", "赣州": "Ganzhou", "宜春": "Yichun",
    "吉安": "Ji'an", "上饶": "Shangrao", "九江": "Jiujiang",
    "萍乡": "Pingxiang", "新余": "Xinyu", "鹰潭": "Yingtan",
    "抚州": "Fuzhou",
    # 安徽
    "安庆": "Anqing", "阜阳": "Fuyang", "池州": "Chizhou",
    "芜湖": "Wuhu", "蚌埠": "Bengbu", "马鞍山": "Ma'anshan",
    "滁州": "Chuzhou", "宣城": "Xuancheng", "六安": "Lu'an",
    "亳州": "Bozhou", "宿州": "Suzhou",
    # 海南
    "琼海": "Qionghai", "文昌": "Wenchang", "万宁": "Wanning",
    "陵水": "Lingshui", "儋州": "Danzhou",
}
