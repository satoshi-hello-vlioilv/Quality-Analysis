# -*- coding: utf-8 -*-
"""アクセス権限（WaveLog backend/repositories/master_repo.py の権限区分・マスタ編集を移したもの）。

**判定はこの1箇所。** ルートにも画面にも書き写さない（写すと「画面では押せるのにサーバーが断る」が作れる）。
画面へは capabilities() の答えを渡すだけ。

置き場: 共有のマスタ `access_permissions`（MasterStore。共有フォルダがあればいつも共有）。
    行: {id, ログインID, PC名, 権限区分, マスタ編集, 有効, 備考, rev, ...}
一致の読み方（_row_for）: ログインID と PC名 が両方合う行 > ログインIDだけの行（PC名が空） > PC名だけの行 > 両方空の行。
    比べるときは NFKC・前後の空白を除く・大文字。「有効」が "無" の行は数えない（消すかわりに止める）。
登録の無い人: 一般ユーザー・マスタ編集は「編集可」（WaveLog と同じ。登録していない PC のマスタ管理を黙って取り上げない）。

権限区分（上から）: 開発者 > メンテナンス者 > 一般ユーザー > 設備作業者
マスタ編集（下から）: 非表示（入口を出さない）/ 閲覧のみ / 部分的編集可（現場のマスタだけ書ける）/ 編集可
    区分ごとの上限で頭打ち（設備作業者は非表示まで）。
    現場のマスタ: 設備マスタ・ロールマスタ。管理のマスタ: アクセス権限・参照先（部分的編集可では書けない）。
"""
from .identity import normalize_part

ROLE_DEVELOPER, ROLE_MAINTAINER, ROLE_USER, ROLE_OPERATOR = "開発者", "メンテナンス者", "一般ユーザー", "設備作業者"
ROLES = (ROLE_DEVELOPER, ROLE_MAINTAINER, ROLE_USER, ROLE_OPERATOR)
ROLE_DEFAULT = ROLE_USER
ROLE_RANK = {ROLE_DEVELOPER: 3, ROLE_MAINTAINER: 2, ROLE_USER: 1, ROLE_OPERATOR: 0}

ME_HIDDEN, ME_VIEW, ME_PARTIAL, ME_FULL = "非表示", "閲覧のみ", "部分的編集可", "編集可"
MASTER_EDIT_LEVELS = (ME_HIDDEN, ME_VIEW, ME_PARTIAL, ME_FULL)
ME_RANK = {ME_HIDDEN: 0, ME_VIEW: 1, ME_PARTIAL: 2, ME_FULL: 3}
MASTER_EDIT_DEFAULT = ME_FULL
ROLE_MASTER_EDIT_CAP = {ROLE_DEVELOPER: ME_FULL, ROLE_MAINTAINER: ME_FULL, ROLE_USER: ME_FULL, ROLE_OPERATOR: ME_HIDDEN}

# マスタの区別（MasterStore の名前）。管理のマスタは「部分的編集可」では書けない
ADMIN_MASTERS = ("access_permissions", "path_settings")


def normalize_role(v):
    v = str(v or "").strip()
    return v if v in ROLES else ROLE_DEFAULT


def role_rank(v):
    return ROLE_RANK.get(normalize_role(v), 0)


def normalize_master_edit(v):
    v = str(v or "").strip()
    return v if v in MASTER_EDIT_LEVELS else MASTER_EDIT_DEFAULT


def master_edit_cap(role):
    return ROLE_MASTER_EDIT_CAP.get(normalize_role(role), ME_HIDDEN)


def master_edit_options(role):
    top = ME_RANK[master_edit_cap(role)]
    return [lv for lv in MASTER_EDIT_LEVELS if ME_RANK[lv] <= top]


def master_edit_effective(role, stored):
    """保存値に区分の上限を掛けた、実際に効く段（区分を下げたのに前の段が効き続けない）。"""
    want, cap = normalize_master_edit(stored), master_edit_cap(role)
    return want if ME_RANK[want] <= ME_RANK[cap] else cap


def master_scope(name):
    return "admin" if name in ADMIN_MASTERS else "field"


def master_edit_can(level, action, scope="field"):
    """'open' … マスタ管理を開く（入口を出す） / 'write' … その scope のマスタへ書く"""
    lv = normalize_master_edit(level)
    if action == "open":
        return lv != ME_HIDDEN
    if action == "write":
        return lv == ME_FULL or (lv == ME_PARTIAL and scope != "admin")
    return False


def role_can(role, action, target_role=""):
    """'presence:view' 利用状況を見る / 'presence:disconnect' 切断（相手の区分も見る） /
    'presence:forget' 使わなくなった PC の記録を消す / 'role:grant' ほかの人の区分を変える（相手の区分も見る） /
    'release:publish' アプリの版を置く・配る版を決める（全員の PC に効く。WaveLog と同じく開発者・メンテナンス者だけ）"""
    r = normalize_role(role)
    if action == "presence:view":
        return r != ROLE_OPERATOR
    if action == "presence:disconnect":
        if r == ROLE_DEVELOPER:
            return True
        return r == ROLE_MAINTAINER and normalize_role(target_role) != ROLE_DEVELOPER
    if action in ("presence:forget", "release:publish"):
        return r in (ROLE_DEVELOPER, ROLE_MAINTAINER)
    if action == "role:grant":
        return r == ROLE_DEVELOPER or role_rank(r) > role_rank(target_role)
    return False


def enabled(row):
    return str(row.get("有効") or "").strip() != "無"


def _row_for(rows, login, pc):
    tl, tp = normalize_part(login), normalize_part(pc)
    exact = login_only = pc_only = global_rule = None
    for r in rows:
        if not enabled(r):
            continue
        rl, rp = normalize_part(r.get("ログインID")), normalize_part(r.get("PC名"))
        if rl and rp:
            if rl == tl and rp == tp:
                exact = r
        elif rl:
            if rl == tl:
                login_only = r
        elif rp:
            if rp == tp:
                pc_only = r
        else:
            global_rule = r
    return exact or login_only or pc_only or global_rule


def covers(row_login, row_pc, login, pc):
    """その行（空欄＝問わない）は、その人・その PC に当たるか。"""
    rl, rp = normalize_part(row_login), normalize_part(row_pc)
    return (not rl or rl == normalize_part(login)) and (not rp or rp == normalize_part(pc))


def flags(rows, login, pc):
    """その人・その PC に効く権限。{role, masterEdit, masterEditStored, matchedId}"""
    r = _row_for(rows or [], login, pc)
    role = normalize_role(r.get("権限区分") if r else "")
    stored = normalize_master_edit(r.get("マスタ編集") if r else "")
    return {"role": role, "masterEdit": master_edit_effective(role, stored), "masterEditStored": stored,
            "matchedId": r.get("id") if r else None}


def capabilities(f):
    """画面へ渡す「できること」。判定を画面へ写さないための窓口。"""
    role, lv = f["role"], f["masterEdit"]
    return {"role": role, "masterEdit": lv, "masterEditStored": f["masterEditStored"], "masterEditCap": master_edit_cap(role),
            "canOpenMaster": master_edit_can(lv, "open"),
            "canEditFieldMaster": master_edit_can(lv, "write", "field"),
            "canEditAdminMaster": master_edit_can(lv, "write", "admin"),
            "adminMasters": list(ADMIN_MASTERS),
            "canViewPresence": role_can(role, "presence:view"),
            "canDisconnect": role_can(role, "presence:disconnect"),
            "canDisconnectDeveloper": role_can(role, "presence:disconnect", ROLE_DEVELOPER),
            "canForget": role_can(role, "presence:forget"),
            "canRelease": role_can(role, "release:publish")}


def registered_roles(rows, pairs):
    """(ログインID, PC名) の組ごとの登録上の区分（利用状況で使う。表は1回だけ読む）。"""
    out = {}
    for login, pc in pairs:
        r = _row_for(rows or [], login, pc)
        out[(login, pc)] = normalize_role(r.get("権限区分") if r else "")
    return out


def has_admin_row(rows):
    """一般ユーザーより上の区分を持つ有効な行が1つでもあるか（無ければ最初の1人を作れる）。"""
    return any(enabled(r) and role_rank(r.get("権限区分")) > role_rank(ROLE_USER) for r in rows or [])


def role_change_check(rows, actor_login, actor_pc, old_role, new_role, row_id=None, row_login="", row_pc=""):
    """区分を old から new へ変えてよいか → (ok, 理由)。3つの門:
    ① 自分の区分を決めている行か（自分では変えられない） ② まだ管理者が居ないか（居なければ通す＝最初の1人）
    ③ 相手の区分・与える区分より上位か（role:grant）。区分が変わらないなら何も要らない。"""
    old, new = normalize_role(old_role), normalize_role(new_role)
    if old == new:
        return True, ""
    me = flags(rows, actor_login, actor_pc)
    mine = (row_id is not None and me["matchedId"] is not None and str(row_id) == str(me["matchedId"])) \
        or (row_id is None and covers(row_login, row_pc, actor_login, actor_pc))
    if mine:
        return False, f"自分の権限区分は自分では変更できません（いまの区分: {me['role']}）。上位の区分を持つ人に変更してもらってください。"
    if not has_admin_row(rows):
        return True, ""
    actor = me["role"]
    if not role_can(actor, "role:grant", old):
        return False, f"この PC の権限区分（{actor}）では、{old}の登録の区分を変更できません。より上位の区分を持つ人に依頼してください。"
    if not role_can(actor, "role:grant", new):
        return False, f"この PC の権限区分（{actor}）では、{new}を与えられません。自分より上位（同格を含む）の区分は付与できません。"
    return True, ""


def delete_check(rows, actor_login, actor_pc, row):
    """その行を消してよいか → (ok, 理由)。消す＝その行が決めていた区分を取り上げること。
    自分の区分を決めている行は消せない。管理者がまだ居なければ通す。居れば、その行の区分より上位でなければ消せない。"""
    me = flags(rows, actor_login, actor_pc)
    if me["matchedId"] is not None and str(row.get("id")) == str(me["matchedId"]):
        return False, "自分の権限を決めている行は自分では消せません。上位の区分を持つ人に依頼してください。"
    if not has_admin_row(rows):
        return True, ""
    target = normalize_role(row.get("権限区分"))
    if not role_can(me["role"], "role:grant", target):
        return False, f"この PC の権限区分（{me['role']}）では、{target}の登録を消せません。"
    return True, ""


def master_edit_check(role, level):
    """その区分にその段を与えてよいか → (ok, 理由)。"""
    r, lv = normalize_role(role), normalize_master_edit(level)
    cap = master_edit_cap(r)
    if ME_RANK[lv] <= ME_RANK[cap]:
        return True, ""
    return False, f"権限区分「{r}」に「{lv}」は与えられません（上限は「{cap}」）。先に権限区分を上げるか、マスタ編集を上限までにしてください。"


def choices():
    """画面の選択欄（区分・段・区分ごとの上限）。"""
    return {"roles": list(ROLES), "masterEditLevels": list(MASTER_EDIT_LEVELS),
            "masterEditByRole": {r: master_edit_options(r) for r in ROLES}}
