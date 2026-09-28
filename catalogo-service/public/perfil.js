function toggleProfileMenu() {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown.classList.contains('dropdown-hidden')) {
    dropdown.classList.remove('dropdown-hidden');
    dropdown.style.display = 'flex';
  } else {
    dropdown.classList.add('dropdown-hidden');
    dropdown.style.display = 'none';
  }
}

function openProfileModal() {
  document.getElementById('editProfileModal').classList.remove('hidden');
  toggleProfileMenu(); // Fecha o menu
}

function fecharProfileModal() {
  document.getElementById('editProfileModal').classList.add('hidden');
}

function salvarFotoPerfil() {
  const fileInput = document.getElementById('fotoPerfilInput');
  const file = fileInput.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const base64Image = e.target.result;
      // Salva no localStorage para simular o backend e exibe
      localStorage.setItem('foto_perfil_' + usuarioLogado.id, base64Image);
      usuarioLogado.foto_perfil = base64Image;
      updateAvatar();
      fecharProfileModal();
      mostrarToast('Foto de perfil atualizada!');
    };
    reader.readAsDataURL(file);
  } else {
    mostrarToast('Selecione uma imagem primeiro.', 'erro');
  }
}

function updateAvatar() {
  if (!usuarioLogado) return;
  const avatarImg = document.getElementById('avatar-img');
  const avatarInitials = document.getElementById('avatar-initials');

  // Verifica se há foto salva localmente
  const fotoSalva = localStorage.getItem('foto_perfil_' + usuarioLogado.id);
  if (fotoSalva) {
    usuarioLogado.foto_perfil = fotoSalva;
  }

  if (usuarioLogado.foto_perfil) {
    avatarImg.src = usuarioLogado.foto_perfil;
    avatarImg.classList.remove('hidden');
    avatarInitials.classList.add('hidden');
  } else {
    // Pegar iniciais
    const partes = usuarioLogado.nome.trim().split(' ');
    let iniciais = '';
    if (partes.length >= 2) {
      iniciais = partes[0][0] + partes[1][0];
    } else if (partes.length === 1) {
      iniciais = partes[0].substring(0, 2);
    }
    avatarInitials.textContent = iniciais.toUpperCase();
    avatarInitials.classList.remove('hidden');
    avatarImg.classList.add('hidden');
  }
}

// Interceptar o carregamento do usuário para atualizar o avatar
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);
  if (args[0] === '/api/auth/me' || (args[0] && args[0].includes('/api/auth/me'))) {
    // Clonamos a resposta para não atrapalhar quem chamou
    const clone = response.clone();
    clone.json().then(data => {
      if (data && data.nome) {
        // Atualiza a global se não estiver setada
        if (typeof usuarioLogado !== 'undefined' && !usuarioLogado) {
           usuarioLogado = data;
        }
        setTimeout(updateAvatar, 100); // Aguarda o iniciarCatalogo terminar
      }
    }).catch(e => {});
  }
  return response;
};
