// =========================================
// PERFIL.JS - Gerenciamento de Perfil
// =========================================

// ---- DROPDOWN DE PERFIL ----

function toggleProfileMenu(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById('profile-dropdown');
  const chevron = document.getElementById('chevronIcon');
  const isOpen = dropdown.style.display === 'block';
  if (isOpen) {
    dropdown.style.display = 'none';
    chevron.style.transform = 'rotate(0deg)';
  } else {
    dropdown.style.display = 'block';
    chevron.style.transform = 'rotate(180deg)';
  }
}

function fecharDropdownPerfil() {
  const dropdown = document.getElementById('profile-dropdown');
  const chevron = document.getElementById('chevronIcon');
  if (dropdown) dropdown.style.display = 'none';
  if (chevron) chevron.style.transform = 'rotate(0deg)';
}

// ---- AVATAR ----

function updateAvatar() {
  if (!usuarioLogado) return;

  const avatarImg = document.getElementById('avatar-img');
  const avatarInitials = document.getElementById('avatar-initials');
  const dropdownAvatar = document.getElementById('dropdownAvatar');
  const dropdownNome = document.getElementById('dropdownNome');
  const dropdownEmail = document.getElementById('dropdownEmail');

  // Atualiza info no header do dropdown
  if (dropdownNome) dropdownNome.textContent = usuarioLogado.nome || '';
  if (dropdownEmail) dropdownEmail.textContent = usuarioLogado.email || '';

  // Verifica foto salva no localStorage
  const fotoSalva = localStorage.getItem('foto_perfil_' + usuarioLogado.id);
  if (fotoSalva && !usuarioLogado.foto_perfil) {
    usuarioLogado.foto_perfil = fotoSalva;
  }

  // Calcula iniciais
  const partes = (usuarioLogado.nome || 'US').trim().split(' ');
  let iniciais = partes.length >= 2
    ? partes[0][0] + partes[1][0]
    : (partes[0].substring(0, 2) || 'US');
  iniciais = iniciais.toUpperCase();

  if (usuarioLogado.foto_perfil) {
    // Mostra foto
    if (avatarImg) { avatarImg.src = usuarioLogado.foto_perfil; avatarImg.style.display = 'block'; }
    if (avatarInitials) avatarInitials.style.display = 'none';
    if (dropdownAvatar) dropdownAvatar.style.backgroundImage = `url(${usuarioLogado.foto_perfil})`;
  } else {
    // Mostra iniciais
    if (avatarImg) avatarImg.style.display = 'none';
    if (avatarInitials) { avatarInitials.textContent = iniciais; avatarInitials.style.display = 'flex'; }
    if (dropdownAvatar) {
      dropdownAvatar.textContent = iniciais;
      dropdownAvatar.style.backgroundImage = '';
    }
  }

  // Atualiza badge de plano no dropdown
  const badge = document.getElementById('dropdownPremiumBadge');
  if (badge) {
    if (usuarioLogado.role === 'admin') {
      badge.style.display = 'inline-block';
      badge.innerHTML = '<i class="fas fa-shield-alt"></i> Admin VIP';
      badge.style.background = 'rgba(229, 9, 20, 0.2)';
      badge.style.borderColor = '#e50914';
      badge.style.color = '#ff6b6b';
    } else if (usuarioLogado.premium) {
      badge.style.display = 'inline-block';
      badge.innerHTML = '⭐ Membro VIP';
      badge.style.background = 'rgba(255, 193, 7, 0.2)';
      badge.style.borderColor = '#ffc107';
      badge.style.color = '#ffc107';
    } else {
      badge.style.display = 'none';
    }
  }

  // Bio salva
  const bioSalva = localStorage.getItem('bio_' + usuarioLogado.id);
  if (bioSalva) usuarioLogado.bio = bioSalva;
}

// ---- MODAL: FOTO DE PERFIL ----

function abrirFotoModal() {
  fecharDropdownPerfil();
  document.getElementById('fotoModal').classList.remove('hidden');
}

function fecharFotoModal() {
  document.getElementById('fotoModal').classList.add('hidden');
}

function salvarFotoPerfil() {
  const fileInput = document.getElementById('fotoPerfilInput');
  const file = fileInput.files[0];
  if (!file) { mostrarToast('Selecione uma imagem primeiro.', 'erro'); return; }

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    localStorage.setItem('foto_perfil_' + usuarioLogado.id, base64);
    usuarioLogado.foto_perfil = base64;
    updateAvatar();
    fecharFotoModal();
    mostrarToast('Foto de perfil atualizada!');
  };
  reader.readAsDataURL(file);
}

// ---- MODAL: BIO ----

function abrirBioModal() {
  fecharDropdownPerfil();
  const textarea = document.getElementById('bioTextarea');
  const bioAtual = localStorage.getItem('bio_' + usuarioLogado.id) || '';
  textarea.value = bioAtual;
  document.getElementById('bioCharCount').textContent = bioAtual.length;
  textarea.addEventListener('input', function() {
    document.getElementById('bioCharCount').textContent = this.value.length;
  });
  document.getElementById('bioModal').classList.remove('hidden');
}

function fecharBioModal() {
  document.getElementById('bioModal').classList.add('hidden');
}

function salvarBio() {
  const bio = document.getElementById('bioTextarea').value.trim();
  localStorage.setItem('bio_' + usuarioLogado.id, bio);
  usuarioLogado.bio = bio;
  fecharBioModal();
  mostrarToast('Bio atualizada!');
}

// ---- MODAL: SENHA ----

function abrirSenhaModal() {
  fecharDropdownPerfil();
  document.getElementById('senhaView').style.display = 'block';
  document.getElementById('novaSenhaView').style.display = 'none';
  document.getElementById('senhaAtualInput').value = '';
  document.getElementById('senhaModal').classList.remove('hidden');
}

function fecharSenhaModal() {
  document.getElementById('senhaModal').classList.add('hidden');
}

async function verificarSenhaAtual() {
  const senhaDigitada = document.getElementById('senhaAtualInput').value;
  if (!senhaDigitada) { mostrarToast('Digite sua senha atual.', 'erro'); return; }

  try {
    // Tenta logar com email + senha atual para verificar
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: usuarioLogado.email, senha: senhaDigitada })
    });
    if (res.ok) {
      document.getElementById('senhaView').style.display = 'none';
      document.getElementById('novaSenhaView').style.display = 'block';
      document.getElementById('novaSenhaInput').value = '';
      document.getElementById('confirmarSenhaInput').value = '';
    } else {
      mostrarToast('Senha atual incorreta!', 'erro');
    }
  } catch (e) {
    mostrarToast('Erro ao verificar senha.', 'erro');
  }
}

async function salvarNovaSenha() {
  const nova = document.getElementById('novaSenhaInput').value;
  const confirmar = document.getElementById('confirmarSenhaInput').value;

  if (nova.length < 6) { mostrarToast('A nova senha deve ter no mínimo 6 caracteres.', 'erro'); return; }
  if (nova !== confirmar) { mostrarToast('As senhas não conferem!', 'erro'); return; }

  try {
    // Usa o endpoint de reset via token — como não temos token aqui,
    // chamamos a rota de reset com a nova senha (o backend valida pela sessão)
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novaSenha: nova })
    });
    if (res.ok) {
      mostrarToast('Senha alterada com sucesso!');
      fecharSenhaModal();
    } else {
      const data = await res.json();
      mostrarToast(data.error || 'Erro ao alterar senha.', 'erro');
    }
  } catch (e) {
    mostrarToast('Erro de conexão.', 'erro');
  }
}

// ---- PÁGINA DE PERFIL (tela de favoritos + bio) ----

async function abrirPerfilPage() {
  if (!usuarioLogado) return;

  // Preenche dados da página de perfil
  document.getElementById('profilePageNome').textContent = usuarioLogado.nome;
  document.getElementById('profilePageEmail').textContent = usuarioLogado.email;

  // Renderiza texto e status de Membro VIP no Perfil
  const statusBox = document.getElementById('profilePageStatusVip');
  if (statusBox) {
    if (usuarioLogado.role === 'admin') {
      statusBox.innerHTML = `
        <div style="background: rgba(229, 9, 20, 0.15); border: 1px solid #e50914; border-radius: 8px; padding: 10px 14px; display: inline-flex; align-items: center; gap: 10px; color: #fff;">
          <i class="fas fa-shield-alt" style="color: #e50914; font-size: 1.3rem;"></i>
          <div>
            <div style="font-weight: bold; color: #fff; font-size: 0.95rem;">Administrador do Sistema</div>
            <div style="font-size: 0.8rem; color: #bbb;">Todos os privilégios e recursos VIP estão inclusos.</div>
          </div>
        </div>`;
    } else if (usuarioLogado.premium) {
      statusBox.innerHTML = `
        <div style="background: linear-gradient(135deg, rgba(255,193,7,0.18), rgba(184,134,11,0.25)); border: 1px solid #ffc107; border-radius: 8px; padding: 10px 14px; display: inline-flex; align-items: center; gap: 10px; color: #fff; box-shadow: 0 0 15px rgba(255,193,7,0.2);">
          <i class="fas fa-crown" style="color: #ffc107; font-size: 1.3rem;"></i>
          <div>
            <div style="font-weight: bold; color: #ffc107; font-size: 0.95rem;">Membro VIP Ativo ✨</div>
            <div style="font-size: 0.8rem; color: #ddd;">Assinatura ativa. Críticas em áudio, moldura dourada e uploads de 10 MB liberados.</div>
          </div>
        </div>`;
    } else {
      statusBox.innerHTML = `
        <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 8px 12px; display: inline-flex; align-items: center; gap: 8px; color: #aaa; font-size: 0.85rem;">
          <i class="fas fa-user"></i>
          <span>Membro Comum — <a href="javascript:void(0)" onclick="fecharPerfilPage(); abrirPremiumModal();" style="color:#ffc107; font-weight:600; text-decoration:underline;">Tornar-se Membro VIP</a></span>
        </div>`;
    }
  }

  const bio = localStorage.getItem('bio_' + usuarioLogado.id) || 'Sem bio ainda.';
  document.getElementById('profilePageBio').textContent = bio;

  // Avatar na página de perfil
  const avatar = document.getElementById('profilePageAvatar');
  const foto = localStorage.getItem('foto_perfil_' + usuarioLogado.id) || usuarioLogado.foto_perfil;
  if (foto) {
    avatar.style.backgroundImage = `url(${foto})`;
    avatar.textContent = '';
  } else {
    const partes = usuarioLogado.nome.trim().split(' ');
    const iniciais = partes.length >= 2 ? partes[0][0] + partes[1][0] : partes[0].substring(0, 2);
    avatar.textContent = iniciais.toUpperCase();
    avatar.style.backgroundImage = '';
  }

  // Carrega favoritos
  const container = document.getElementById('profilePageFavoritos');
  container.innerHTML = '<p style="color:#888;">Carregando favoritos...</p>';
  try {
    const res = await fetch('/api/favoritos', { cache: 'no-store' });
    const favoritos = await res.json();
    container.innerHTML = '';
    if (!favoritos || favoritos.length === 0) {
      container.innerHTML = '<p style="color:#888; font-style:italic;">Nenhum filme favoritado ainda.</p>';
    } else {
      favoritos.forEach(f => {
        const card = document.createElement('div');
        card.className = 'filme-card';
        card.innerHTML = `
          <div class="poster-container">
            <img src="https://image.tmdb.org/t/p/w500${f.poster_path}" alt="${f.titulo}">
          </div>
          <div class="card-info">
            <h3>${f.titulo}</h3>
          </div>
        `;
        container.appendChild(card);
      });
    }
  } catch (e) {
    container.innerHTML = '<p style="color:#e50914;">Erro ao carregar favoritos.</p>';
  }

  // Troca de tela
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('profilePage').style.display = 'block';
  window.scrollTo(0, 0);
}

function fecharPerfilPage() {
  document.getElementById('profilePage').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';
}

// ---- INTERCEPTAR FETCH /api/auth/me PARA ATUALIZAR AVATAR ----
const _originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await _originalFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : '';
  if (url.includes('/api/auth/me')) {
    const clone = response.clone();
    clone.json().then(data => {
      if (data && data.id) {
        setTimeout(updateAvatar, 80);
      }
    }).catch(() => {});
  }
  return response;
};
